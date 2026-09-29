package tempo

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/stats"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protowire"
)

const validRedactionBody = `{"attributeRedactions":[{"key":"span.enc.secret","valuePrefix":"enc:v1:630dcd2966c4336691125448bbb25b4f"},{"key":"span.bi.secret","valuePrefix":"bi:v1:630dcd2966c4336691125448bbb25b4f"}]}`

// Independent wire decoder: decoding via the bridge's own Go messages would
// fail to catch a field-number or RPC-path mismatch with backendwork.proto.
type schedulerWireAttribute struct{ Key, Prefix string }
type schedulerWireRequest struct {
	Attributes  []schedulerWireAttribute
	OtherFields bool
}
type schedulerWireReply struct {
	Batch string
	Jobs  int32
}
type schedulerWireCodec struct{}

func (schedulerWireCodec) Name() string { return "proto" }
func (schedulerWireCodec) Marshal(v any) ([]byte, error) {
	reply := v.(*schedulerWireReply)
	b := protowire.AppendString(protowire.AppendTag(nil, 1, protowire.BytesType), reply.Batch)
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	return protowire.AppendVarint(b, uint64(reply.Jobs)), nil
}
func (schedulerWireCodec) Unmarshal(data []byte, v any) error {
	req := v.(*schedulerWireRequest)
	for len(data) != 0 {
		field, typ, n := protowire.ConsumeTag(data)
		if n < 0 {
			return errors.New("invalid protobuf tag")
		}
		data = data[n:]
		if field != 8 || typ != protowire.BytesType {
			req.OtherFields = true
		}
		if field == 8 && typ == protowire.BytesType {
			attr, size := protowire.ConsumeBytes(data)
			if size < 0 {
				return errors.New("invalid protobuf attribute")
			}
			var rule schedulerWireAttribute
			for len(attr) != 0 {
				id, kind, consumed := protowire.ConsumeTag(attr)
				if consumed < 0 || kind != protowire.BytesType {
					return errors.New("invalid protobuf attribute field")
				}
				attr = attr[consumed:]
				value, n := protowire.ConsumeString(attr)
				if n < 0 {
					return errors.New("invalid protobuf attribute value")
				}
				switch id {
				case 1:
					rule.Key = value
				case 2:
					rule.Prefix = value
				default:
					req.OtherFields = true
				}
				attr = attr[n:]
			}
			req.Attributes = append(req.Attributes, rule)
			n = size
		} else {
			n = protowire.ConsumeFieldValue(field, typ, data)
			if n < 0 {
				return errors.New("invalid protobuf field")
			}
		}
		data = data[n:]
	}
	return nil
}

type schedulerWireService interface{}

type schedulerEndStats struct{ end chan struct{} }

func (*schedulerEndStats) TagRPC(ctx context.Context, _ *stats.RPCTagInfo) context.Context {
	return ctx
}
func (*schedulerEndStats) HandleRPC(context.Context, stats.RPCStats) {}
func (*schedulerEndStats) TagConn(ctx context.Context, _ *stats.ConnTagInfo) context.Context {
	return ctx
}
func (s *schedulerEndStats) HandleConn(_ context.Context, event stats.ConnStats) {
	if _, ok := event.(*stats.ConnEnd); ok {
		select {
		case s.end <- struct{}{}:
		default:
		}
	}
}

func startRedactionScheduler(t *testing.T, handler func(context.Context, *schedulerWireRequest) (*schedulerWireReply, error)) (string, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	connStats := &schedulerEndStats{end: make(chan struct{}, 2)}
	server := grpc.NewServer(grpc.ForceServerCodec(schedulerWireCodec{}), grpc.StatsHandler(connStats))
	server.RegisterService(&grpc.ServiceDesc{
		ServiceName: "tempopb.BackendScheduler", HandlerType: (*schedulerWireService)(nil),
		Methods: []grpc.MethodDesc{{MethodName: "SubmitAttributeRedaction", Handler: func(_ any, ctx context.Context, decode func(any) error, interceptor grpc.UnaryServerInterceptor) (any, error) {
			invoke := func(ctx context.Context, req any) (any, error) { return handler(ctx, req.(*schedulerWireRequest)) }
			req := new(schedulerWireRequest)
			if err := decode(req); err != nil {
				return nil, err
			}
			if interceptor != nil {
				return interceptor(ctx, req, &grpc.UnaryServerInfo{FullMethod: redactionRPC}, invoke)
			}
			return invoke(ctx, req)
		}}},
	}, struct{}{})
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return listener.Addr().String(), connStats.end
}

func newRedactionTestDatasource(t *testing.T, schedulerURL, tenant string) *DataSource {
	t.Helper()
	settings := backend.DataSourceInstanceSettings{JSONData: []byte(`{"redactionSchedulerURL":"` + schedulerURL + `","httpHeaderName1":"X-Scope-OrgID"}`), DecryptedSecureJSONData: map[string]string{"httpHeaderValue1": tenant}}
	opts, err := settings.HTTPClientOptions(context.Background())
	require.NoError(t, err)
	ds := &DataSource{redaction: newRedactionBridge(settings, opts)}
	mux := http.NewServeMux()
	mux.HandleFunc("/redaction/capabilities", ds.handleRedactionCapabilities)
	mux.HandleFunc("/redaction", ds.handleRedaction)
	ds.resourceHandler = httpadapter.New(mux)
	return ds
}

func redactionCall(t *testing.T, ds *DataSource, method, path, body string, user *backend.User, headers map[string][]string, ctx context.Context) *backend.CallResourceResponse {
	t.Helper()
	var response *backend.CallResourceResponse
	err := ds.CallResource(ctx, &backend.CallResourceRequest{
		Path: path, URL: path, Method: method, Body: []byte(body), Headers: headers,
		PluginContext: backend.PluginContext{User: user},
	}, backend.CallResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error { response = r; return nil }))
	require.NoError(t, err)
	require.NotNil(t, response)
	return response
}

func TestRedactionAuthorizationAndMethods(t *testing.T) {
	var calls atomic.Int32
	addr, _ := startRedactionScheduler(t, func(ctx context.Context, _ *schedulerWireRequest) (*schedulerWireReply, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok || strings.Join(md.Get("x-scope-orgid"), ",") != "single-tenant" {
			return nil, status.Error(codes.InvalidArgument, "unexpected tenant metadata")
		}
		calls.Add(1)
		return &schedulerWireReply{Batch: "batch", Jobs: 2}, nil
	})
	ds := newRedactionTestDatasource(t, "http://"+addr, "single-tenant")
	admin := &backend.User{Login: "operator", Role: "Admin"}
	for _, tc := range []struct {
		name    string
		user    *backend.User
		allowed bool
	}{
		{"nil", nil, false},
		{"viewer", &backend.User{Login: "viewer", Role: "Viewer"}, false},
		{"editor", &backend.User{Login: "editor", Role: "Editor"}, false},
		{"unknown role", &backend.User{Login: "operator", Role: "Owner"}, false},
		{"mismatched role", &backend.User{Login: "operator", Role: "admin"}, false},
		{"empty login admin", &backend.User{Role: "Admin"}, true},
		{"anonymous login admin", &backend.User{Login: "anonymous", Role: "Admin"}, true},
		{"named admin", admin, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := map[string][]string{"X-Grafana-Role": {"Admin"}, "X-Scope-OrgID": {"spoofed-tenant"}}
			capabilities := redactionCall(t, ds, "GET", "/redaction/capabilities", "", tc.user, headers, context.Background())
			require.Equal(t, http.StatusOK, capabilities.Status)
			var result struct{ Enabled, CanSubmit bool }
			require.NoError(t, json.Unmarshal(capabilities.Body, &result))
			require.True(t, result.Enabled)
			require.Equal(t, tc.allowed, result.CanSubmit)

			before := calls.Load()
			response := redactionCall(t, ds, "POST", "/redaction", validRedactionBody, tc.user, headers, context.Background())
			if tc.allowed {
				require.Equal(t, http.StatusOK, response.Status, string(response.Body))
				require.JSONEq(t, `{"batchId":"batch","jobsCreated":2}`, string(response.Body))
				require.Equal(t, before+1, calls.Load())
			} else {
				require.Equal(t, http.StatusForbidden, response.Status)
				require.Contains(t, string(response.Body), "Grafana org Admin required")
				require.Equal(t, before, calls.Load())
			}
		})
	}
	require.Equal(t, http.StatusMethodNotAllowed, redactionCall(t, ds, "GET", "/redaction", "", admin, nil, context.Background()).Status)
	require.Equal(t, http.StatusMethodNotAllowed, redactionCall(t, ds, "POST", "/redaction/capabilities", "", admin, nil, context.Background()).Status)
	require.EqualValues(t, 3, calls.Load())
}

func TestRedactionDisabledForUnsafeOrMissingConfiguration(t *testing.T) {
	admin := &backend.User{Login: "operator", Role: "Admin"}
	for _, tc := range []struct{ url, tenant string }{
		{"", "tenant"}, {"http://localhost:9095", ""}, {"http://localhost:9095", "other|tenant"},
		{"http://localhost:9095/path", "tenant"}, {"https://user@localhost:9095", "tenant"},
		{"file:///tmp/socket", "tenant"}, {"http://localhost", "tenant"}, {"http://localhost:0", "tenant"},
		{"http://localhost:9095?tenant=other", "tenant"},
	} {
		ds := newRedactionTestDatasource(t, tc.url, tc.tenant)
		r := redactionCall(t, ds, "GET", "/redaction/capabilities", "", admin, nil, context.Background())
		require.JSONEq(t, `{"enabled":false,"canSubmit":false}`, string(r.Body), tc)
		r = redactionCall(t, ds, "POST", "/redaction", validRedactionBody, admin, nil, context.Background())
		require.Equal(t, http.StatusServiceUnavailable, r.Status, tc)
	}
}

func TestRedactionRejectsInvalidBodiesWithoutSchedulerCall(t *testing.T) {
	var calls atomic.Int32
	addr, _ := startRedactionScheduler(t, func(context.Context, *schedulerWireRequest) (*schedulerWireReply, error) {
		calls.Add(1)
		return &schedulerWireReply{}, nil
	})
	ds := newRedactionTestDatasource(t, "http://"+addr, "tenant")
	admin := &backend.User{Login: "operator", Role: "Admin"}
	pair := strings.TrimSuffix(strings.TrimPrefix(validRedactionBody, `{"attributeRedactions":[`), `]}`)
	var distinctPairs []string
	for i := 0; i <= redactionMaxPairs; i++ {
		distinctPairs = append(distinctPairs, strings.ReplaceAll(pair, "secret", strconv.Itoa(i)))
	}
	for _, body := range []string{
		`{}`, `null`, `{"attributeRedactions":null}`, `{"attributeRedactions":[]}`,
		`{"attributeRedaction":{"key":"span.enc.secret","valuePrefix":"enc:v1:630dcd2966c4336691125448bbb25b4f"}}`,
		strings.Replace(validRedactionBody, `]}`, `],"traceIds":["raw"]}`, 1),
		strings.Replace(validRedactionBody, `"key":"span.enc.secret"`, `"key":"span.enc.secret","tenant":"other"`, 1),
		`{"attributeRedactions":[` + strings.Split(pair, `},{`)[0] + `}]}`,
		strings.Replace(validRedactionBody, "span.enc.secret", "span.secret", 1),
		strings.Replace(validRedactionBody, "span.enc.secret", "instrumentation.enc.secret", 1),
		strings.Replace(validRedactionBody, "span.enc.secret", "span.enc.", 1),
		strings.Replace(validRedactionBody, "span.enc.secret", `span.enc.\nsecret`, 1),
		strings.Replace(validRedactionBody, "span.bi.secret", "resource.bi.secret", 1),
		strings.Replace(validRedactionBody, "span.bi.secret", "span.bi.other", 1),
		strings.Replace(validRedactionBody, "span.bi.secret", "span.enc.secret", 1),
		strings.Replace(validRedactionBody, "630dcd2966c4336691125448bbb25b4f", "630DCD2966C4336691125448BBB25B4F", 1),
		strings.Replace(validRedactionBody, "bi:v1:", "enc:v1:", 1),
		strings.Replace(validRedactionBody, "bi:v1:", "bi:v2:", 1),
		strings.Replace(validRedactionBody, "bi:v1:630", "bi:v1:730", 1),
		`{"attributeRedactions":[` + pair + `,` + pair + `]}`,
		`{"attributeRedactions":[` + strings.Join(distinctPairs, ",") + `]}`,
		validRedactionBody + validRedactionBody,
		validRedactionBody + strings.Repeat(" ", redactionMaxBody),
	} {
		r := redactionCall(t, ds, "POST", "/redaction", body, admin, nil, context.Background())
		require.Contains(t, []int{http.StatusBadRequest, http.StatusRequestEntityTooLarge}, r.Status, body)
	}
	require.Zero(t, calls.Load())
}

func TestRedactionSubmitPairedWireTenantResponseAndConnectionClose(t *testing.T) {
	observed := make(chan struct{}, 1)
	var calls atomic.Int32
	addr, ended := startRedactionScheduler(t, func(ctx context.Context, req *schedulerWireRequest) (*schedulerWireReply, error) {
		calls.Add(1)
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok || strings.Join(md.Get("x-scope-orgid"), ",") != "single-tenant" || len(md.Get("authorization")) != 0 ||
			req.OtherFields || len(req.Attributes) != 4 {
			return nil, status.Error(codes.InvalidArgument, "wire contract mismatch")
		}
		expected := []schedulerWireAttribute{
			{"span.enc.secret", "enc:v1:630dcd2966c4336691125448bbb25b4f"},
			{"span.bi.secret", "bi:v1:630dcd2966c4336691125448bbb25b4f"},
			{"resource.enc.token", "enc:v1:630dcd2966c4336691125448bbb25b4f"},
			{"resource.bi.token", "bi:v1:630dcd2966c4336691125448bbb25b4f"},
		}
		if !reflect.DeepEqual(req.Attributes, expected) {
			return nil, status.Error(codes.InvalidArgument, "wire rules mismatch")
		}
		observed <- struct{}{}
		return &schedulerWireReply{Batch: "batch-123", Jobs: 7}, nil
	})
	ds := newRedactionTestDatasource(t, "http://"+addr, "single-tenant")
	admin := &backend.User{Login: "operator", Role: "Admin"}
	body := strings.TrimSuffix(validRedactionBody, `]}`) + `,{"key":"resource.enc.token","valuePrefix":"enc:v1:630dcd2966c4336691125448bbb25b4f"},{"key":"resource.bi.token","valuePrefix":"bi:v1:630dcd2966c4336691125448bbb25b4f"}]}`
	ctx := metadata.NewOutgoingContext(context.Background(), metadata.Pairs("x-scope-orgid", "attacker", "authorization", "Bearer attacker"))
	r := redactionCall(t, ds, "POST", "/redaction", body, admin, map[string][]string{"X-Scope-OrgID": {"attacker"}, "Authorization": {"Bearer attacker"}}, ctx)
	require.Equal(t, http.StatusOK, r.Status, string(r.Body))
	require.JSONEq(t, `{"batchId":"batch-123","jobsCreated":7}`, string(r.Body))
	require.EqualValues(t, 1, calls.Load())
	select {
	case <-observed:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not receive submission")
	}
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("scheduler connection was not closed")
	}
}

func TestRedactionSchedulerConflictErrorAndCancellation(t *testing.T) {
	admin := &backend.User{Login: "operator", Role: "Admin"}
	addr, _ := startRedactionScheduler(t, func(context.Context, *schedulerWireRequest) (*schedulerWireReply, error) {
		return nil, status.Error(codes.AlreadyExists, "sensitive scheduler details")
	})
	ds := newRedactionTestDatasource(t, "http://"+addr, "tenant")
	r := redactionCall(t, ds, "POST", "/redaction", validRedactionBody, admin, nil, context.Background())
	require.Equal(t, http.StatusConflict, r.Status)
	require.Contains(t, string(r.Body), "already active")
	require.NotContains(t, string(r.Body), "sensitive scheduler details")

	started := make(chan struct{}, 1)
	addr, _ = startRedactionScheduler(t, func(ctx context.Context, _ *schedulerWireRequest) (*schedulerWireReply, error) {
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	ds = newRedactionTestDatasource(t, "http://"+addr, "tenant")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	response := make(chan *backend.CallResourceResponse, 1)
	go func() {
		var r *backend.CallResourceResponse
		_ = ds.CallResource(ctx, &backend.CallResourceRequest{Path: "/redaction", URL: "/redaction", Method: "POST", Body: []byte(validRedactionBody), PluginContext: backend.PluginContext{User: admin}}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error { r = resp; return nil }))
		response <- r
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("scheduler RPC did not start")
	}
	cancel()
	select {
	case r := <-response:
		require.NotNil(t, r)
		require.Equal(t, http.StatusGatewayTimeout, r.Status)
	case <-time.After(time.Second):
		t.Fatal("canceled request did not terminate")
	}
}

func TestRedactionConfiguredBasicAuthAndDownstreamError(t *testing.T) {
	var calls atomic.Int32
	addr, _ := startRedactionScheduler(t, func(ctx context.Context, req *schedulerWireRequest) (*schedulerWireReply, error) {
		calls.Add(1)
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok || strings.Join(md.Get("authorization"), ",") != basicHeaderForAuth("operator", "configured-password") ||
			strings.Join(md.Get("x-scope-orgid"), ",") != "configured-tenant" {
			return nil, status.Error(codes.InvalidArgument, "trusted metadata missing")
		}
		return nil, status.Error(codes.Internal, "scheduler private diagnostics")
	})
	settings := backend.DataSourceInstanceSettings{
		JSONData:                []byte(`{"redactionSchedulerURL":"http://` + addr + `","httpHeaderName1":"X-Scope-OrgID"}`),
		DecryptedSecureJSONData: map[string]string{"httpHeaderValue1": "configured-tenant", "basicAuthPassword": "configured-password"},
		BasicAuthEnabled:        true,
		BasicAuthUser:           "operator",
	}
	opts, err := settings.HTTPClientOptions(context.Background())
	require.NoError(t, err)
	ds := &DataSource{redaction: newRedactionBridge(settings, opts)}
	mux := http.NewServeMux()
	mux.HandleFunc("/redaction", ds.handleRedaction)
	ds.resourceHandler = httpadapter.New(mux)
	admin := &backend.User{Login: "admin", Role: "Admin"}
	r := redactionCall(t, ds, "POST", "/redaction", validRedactionBody, admin,
		map[string][]string{"Authorization": {"Bearer attacker"}, "X-Scope-OrgID": {"attacker"}}, context.Background())
	require.Equal(t, http.StatusBadGateway, r.Status)
	require.NotContains(t, string(r.Body), "scheduler private diagnostics")
	require.Equal(t, int32(1), calls.Load(), "submit must not retry a failed operation")
}
