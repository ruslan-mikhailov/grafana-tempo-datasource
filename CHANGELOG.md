# Changelog

## Unreleased

- Submit up to 32 selected protected attributes with their hidden same-scope `bi.*` partners through one administrator-authorized Grafana bridge request and one Tempo `SubmitAttributeRedaction` batch. Tempo removes matching sidecars in the same backend-block rewrite as `enc.*` replacement; submissions report queued jobs, not completion. Requires rebuilt Grafana plugin and Tempo scheduler/worker.

- Open the local file picker directly from the key-revocation form's **Choose local key file** action, including after switching from paste mode; remove the redundant file-mode button.
- Pass protected query values starting with `enc:` unchanged in Raw and Builder `=`, `!=`, `=~`, `!~`, `@>`, and `!@>` predicates, without a key, envelope-format checks, or automatic projection. Encrypt non-prefixed regex literals with the selected key; keep non-prefixed substring predicates on indexed search. Ciphertext substring inspection requires the matching Tempo validation update, not a blind index. Omit incomplete autocomplete context from metadata requests while retaining ordinary value suggestions; keep unfinished drafts local and validate on explicit Run.
- Fix the clipped key-revocation file picker by using a Grafana button to open the local file dialog; add spacing between key-loading controls.
- Remove the protected substring-search settings switch while retaining provisioned query support. Make both demo Tempo datasources editable, and authorize key revocation by Grafana's trusted organization Admin role, including anonymous Admins.
- Add administrator-only key revocation in Tempo datasource settings: load a base64 key locally, discover `enc` attributes, confirm irreversible replacement, and submit scheduler jobs through an authorized backend bridge. Require a provisioned scheduler URL and tenant; show queued batches and failures without automatic retries. Protected substring search is not required.
- Add opt-in protected span substring search (`@>` and `!@>`): browser-side NFC trigrams, pinned TraceQL parser, internal `subarray_seq` index queries, and guarded Builder/metadata/HTTP/Live paths. Handle non-index array attributes without a search-result panic; omit `bi.*` from Grafana search frames while retaining Tempo storage and direct API access. Requires matching Alloy and Tempo builds; protected terms shorter than three Unicode scalars are rejected.
- Display protected Tempo span values in the stock Grafana Traces table and trace detail when the browser key is loaded; keep returned frames and host actions encrypted. Requires the accompanying `grafana-h` host build.
- Open the protected key entry dialog after forgetting a key, with the old key and input cleared.
- Remove the configured protected key ID: enable protection once and import or replace browser keys without changing Grafana datasource configuration.

## 13.2.0

- Bump go v1.26.7 and grafana-plugin-sdk-go v0.296.4 ([#229](https://github.com/grafana/grafana-tempo-datasource/pull/220))
- Fix search query error details not propagated to user ([#203](https://github.com/grafana/grafana-tempo-datasource/pull/203))
- Search: Allow a custom label for static search fields ([#205](https://github.com/grafana/grafana-tempo-datasource/pull/205))
- Return a friendly error instead of raw HTML on non-2xx Tempo responses ([#214](https://github.com/grafana/grafana-tempo-datasource/pull/214))
- Do not escape a single value regex in TraceQL search filters ([#211](https://github.com/grafana/grafana-tempo-datasource/pull/211))
- Fix: Show query error details for unsupported query types instead of a generic plugin error ([#222](https://github.com/grafana/grafana-tempo-datasource/pull/222))
- Update dependencies ([#232](https://github.com/grafana/grafana-tempo-datasource/pull/232))
- Tempo: Normalize provisioned timeRangeForTags duration strings ([#234](https://github.com/grafana/grafana-tempo-datasource/pull/234))
- Return a clearer error when a trace is not found in the time range ([#213](https://github.com/grafana/grafana-tempo-datasource/pull/213))
- Fix: Avoid double slash in trace and metrics URLs ([#212](https://github.com/grafana/grafana-tempo-datasource/pull/212))
- Tempo: Quote custom search values when tag value type is unknown ([#224](https://github.com/grafana/grafana-tempo-datasource/pull/224))
- Tempo: Fix options row padding ([#238](https://github.com/grafana/grafana-tempo-datasource/pull/238))
- Add valueType to getTagValues results ([#239](https://github.com/grafana/grafana-tempo-datasource/pull/239))
- Fix: Keep last metrics payload on streaming Done ([#237](https://github.com/grafana/grafana-tempo-datasource/pull/237))


## 13.1.5

- Fix: Avoid duplicate X-Scope-OrgID header on streaming search ([#207](https://github.com/grafana/grafana-tempo-datasource/pull/207))

## 13.1.4

- Fix: Case-insensitive header collision when forwarding team headers ([#199](https://github.com/grafana/grafana-tempo-datasource/pull/199))

## 13.1.3

- Fix path traversal GL-Vuln: VUL-2026-0062 ([#197](https://github.com/grafana/grafana-tempo-datasource/pull/197))

## 13.1.2

- Bump go v1.26.4
- Search: Unify nested span subframe schema across span sets
- Update various backend and frontend dependencies

## 13.1.1

- Minor improvements and bug fixes
