package tempo

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gogo/protobuf/proto"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	redactionRPC      = "/tempopb.BackendScheduler/SubmitAttributeRedaction"
	redactionTimeout  = 15 * time.Second
	redactionMaxBody  = 32 * 1024
	redactionMaxPairs = 32
)

var (
	redactionPrefixPattern = regexp.MustCompile(`^(enc|bi):v1:([0-9a-f]{32})$`)
	// A single tenant only: reject multi-tenant separators and metadata control characters.
	redactionTenantPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
)

type redactionBridge struct {
	address   string
	tenant    string
	tlsConfig *tls.Config
	basicAuth string
}

// The SDK resolves configured httpHeaderNameN/httpHeaderValueN pairs into opts.Header.
// Neither incoming HTTP headers nor request PluginContext settings are used for routing.
func newRedactionBridge(settings backend.DataSourceInstanceSettings, opts httpclient.Options) *redactionBridge {
	var config struct {
		URL string `json:"redactionSchedulerURL"`
	}
	if json.Unmarshal(settings.JSONData, &config) != nil || config.URL == "" {
		return nil
	}
	parsed, err := url.Parse(config.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawFragment != "" || parsed.Opaque != "" {
		return nil
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || parsed.Hostname() == "" {
		return nil
	}

	tenants := opts.Header.Values("X-Scope-OrgID")
	if len(tenants) != 1 || !redactionTenantPattern.MatchString(tenants[0]) {
		return nil
	}
	bridge := &redactionBridge{address: parsed.Host, tenant: tenants[0]}
	if parsed.Scheme == "https" {
		bridge.tlsConfig, err = httpclient.GetTLSConfig(opts)
		if err != nil {
			return nil
		}
	}
	if opts.BasicAuth != nil {
		bridge.basicAuth = basicHeaderForAuth(opts.BasicAuth.User, opts.BasicAuth.Password)
	}
	return bridge
}

func redactionAdmin(ctx context.Context) bool {
	user := backend.UserFromContext(ctx)
	return user != nil && user.Role == "Admin"
}

func (ds *DataSource) handleRedactionCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Enabled   bool `json:"enabled"`
		CanSubmit bool `json:"canSubmit"`
	}{Enabled: ds.redaction != nil, CanSubmit: ds.redaction != nil && redactionAdmin(r.Context())})
}

func (ds *DataSource) handleRedaction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !redactionAdmin(r.Context()) {
		http.Error(w, "Grafana org Admin required", http.StatusForbidden)
		return
	}
	if ds.redaction == nil {
		http.Error(w, "redaction scheduler is not configured", http.StatusServiceUnavailable)
		return
	}
	var input struct {
		AttributeRedactions []redactionAttribute `json:"attributeRedactions"`
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, redactionMaxBody+1))
	if err != nil {
		http.Error(w, "invalid redaction request", http.StatusBadRequest)
		return
	}
	if len(body) > redactionMaxBody {
		http.Error(w, "redaction request too large", http.StatusRequestEntityTooLarge)
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		http.Error(w, "invalid redaction request", http.StatusBadRequest)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid redaction request", http.StatusBadRequest)
		return
	}
	if !validRedactionPairs(input.AttributeRedactions) {
		http.Error(w, "invalid attribute redactions", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), redactionTimeout)
	defer cancel()
	response, err := ds.redaction.submit(ctx, input.AttributeRedactions)
	if err != nil {
		switch {
		case status.Code(err) == codes.AlreadyExists:
			http.Error(w, "a redaction batch is already active for this tenant; retry after it completes", http.StatusConflict)
		case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
			status.Code(err) == codes.Canceled || status.Code(err) == codes.DeadlineExceeded:
			http.Error(w, "redaction scheduler request timed out or was canceled", http.StatusGatewayTimeout)
		default:
			http.Error(w, "redaction scheduler request failed", http.StatusBadGateway)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		BatchID     string `json:"batchId"`
		JobsCreated int32  `json:"jobsCreated"`
	}{BatchID: response.BatchID, JobsCreated: response.JobsCreated})
}

func validRedactionPairs(attributes []redactionAttribute) bool {
	if len(attributes) == 0 || len(attributes) > 2*redactionMaxPairs || len(attributes)%2 != 0 {
		return false
	}
	seen := make(map[string]struct{}, len(attributes)/2)
	for i := 0; i < len(attributes); i += 2 {
		enc, bi := attributes[i], attributes[i+1]
		scope, name, ok := strings.Cut(enc.Key, ".enc.")
		if !ok || (scope != "span" && scope != "resource") || name == "" || strings.ContainsFunc(name, unicode.IsControl) ||
			bi.Key != scope+".bi."+name {
			return false
		}
		encPrefix := redactionPrefixPattern.FindStringSubmatch(enc.ValuePrefix)
		biPrefix := redactionPrefixPattern.FindStringSubmatch(bi.ValuePrefix)
		if encPrefix == nil || biPrefix == nil || encPrefix[1] != "enc" || biPrefix[1] != "bi" || encPrefix[2] != biPrefix[2] {
			return false
		}
		if _, duplicate := seen[enc.Key]; duplicate {
			return false
		}
		seen[enc.Key] = struct{}{}
	}
	return true
}

func (bridge *redactionBridge) submit(ctx context.Context, attributes []redactionAttribute) (*redactionResponse, error) {
	var transport credentials.TransportCredentials = insecure.NewCredentials()
	if bridge.tlsConfig != nil {
		transport = credentials.NewTLS(bridge.tlsConfig)
	}
	conn, err := grpc.DialContext(ctx, bridge.address, grpc.WithTransportCredentials(transport), grpc.WithBlock(),
		grpc.WithDisableRetry(), grpc.WithDefaultCallOptions(grpc.ForceCodec(redactionCodec{})))
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	// Replace rather than append: even preexisting outgoing metadata must not override
	// the configured tenant. Only explicit trusted metadata crosses this boundary.
	md := metadata.Pairs("x-scope-orgid", bridge.tenant)
	if bridge.basicAuth != "" {
		md.Set("authorization", bridge.basicAuth)
	}
	ctx = metadata.NewOutgoingContext(ctx, md)
	request := &redactionRequest{AttributeRedactions: make([]*redactionAttribute, len(attributes))}
	for i := range attributes {
		request.AttributeRedactions[i] = &attributes[i]
	}
	response := new(redactionResponse)
	if err := conn.Invoke(ctx, redactionRPC, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

// These minimal gogo wire messages match backendwork.proto in tempo-h. The
// published Tempo dependency predates SubmitAttributeRedaction; keep the binding
// small instead of replacing its whole module.
// Wire fields: request attribute_redactions=8; attribute key=1,prefix=2;
// response batch_id=1,jobs_created=2. All other request fields stay unset.
type redactionRequest struct {
	AttributeRedactions []*redactionAttribute `protobuf:"bytes,8,rep,name=attribute_redactions,json=attributeRedactions,proto3"`
}

type redactionAttribute struct {
	Key         string `protobuf:"bytes,1,opt,name=key,proto3"`
	ValuePrefix string `protobuf:"bytes,2,opt,name=value_prefix,json=valuePrefix,proto3"`
}

type redactionResponse struct {
	BatchID     string `protobuf:"bytes,1,opt,name=batch_id,json=batchId,proto3"`
	JobsCreated int32  `protobuf:"varint,2,opt,name=jobs_created,json=jobsCreated,proto3"`
}

func (m *redactionRequest) Reset()           { *m = redactionRequest{} }
func (m *redactionAttribute) Reset()         { *m = redactionAttribute{} }
func (m *redactionResponse) Reset()          { *m = redactionResponse{} }
func (m *redactionRequest) String() string   { return proto.CompactTextString(m) }
func (m *redactionAttribute) String() string { return proto.CompactTextString(m) }
func (m *redactionResponse) String() string  { return proto.CompactTextString(m) }
func (*redactionRequest) ProtoMessage()      {}
func (*redactionAttribute) ProtoMessage()    {}
func (*redactionResponse) ProtoMessage()     {}

type redactionCodec struct{}

func (redactionCodec) Name() string { return "proto" }
func (redactionCodec) Marshal(m any) ([]byte, error) {
	return proto.Marshal(m.(proto.Message))
}
func (redactionCodec) Unmarshal(data []byte, m any) error {
	return proto.Unmarshal(data, m.(proto.Message))
}
