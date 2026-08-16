# Domain-Monitor — Monitoring Semantics & Error Codes

> How DNS/SSL/HTTP checks behave and how failures are classified (V0.7.3). Raw errors never leave server logs; only machine codes reach UI/DB/actions.

## DNS

- **Transport**: DNS-over-HTTPS JSON (`DNS_DOH_ENDPOINT` env, default `https://cloudflare-dns.com/dns-query`; alternate `https://dns.google/resolve`). Timeout 8 s per query, `AbortSignal.timeout`, `cache: "no-store"`.
- **Queries**: 7 record types (A, AAAA, CNAME, MX, NS, TXT, CAA) in **parallel** (`Promise.all`).
- **Success semantics**: DoH status 0 (NOERROR) or 3 (NXDOMAIN) are successful queries. NXDOMAIN simply means "no records" — **never an error**, snapshot is written with whatever records exist (possibly 0).
- **Failure semantics**: any other status (resolver error), transport error, timeout, or invalid response fails the **whole check** → `{ok:false, errorCode}` and **no snapshot is written** (previous data preserved, no events).
- **Client error codes** (`DnsError.code`): `timeout`, `network`, `invalid-response`, `resolver-error`.

## SSL

- **Transport**: `tls.connect(host, {port:443, servername:host, rejectUnauthorized:false, timeout:8000})`; reads leaf cert via `socket.getPeerX509Certificate()`; captures protocol + cipher.
- **Classification** (`classifySslStatus`): hostname mismatch → `mismatch`; expiry < 0 → `expired`; ≤30 days → `expires_soon`; else `ok`. Certificate details are never trusted for business decisions.
- **Failure semantics**: any TLS failure writes an **error snapshot** (`status='error'`, `error=<code>`) preserving prior certificate history, and returns `{ok:false, errorCode}`.
- **Client error codes** (`SslError.code`): `timeout`, `network` (ECONNRESET/EHOSTUNREACH/ENETUNREACH), **`dns-failed` (ENOTFOUND/EAI_AGAIN — V0.7.3)**, `handshake` (ERR_SSL_*/EPROTO), `no-tls-service` (ECONNREFUSED), `invalid-cert`.

## HTTP

- **Transport**: GET `https://<host>/`, manual redirects (max 5), 8 s timeout, `cache: no-store`. Hostname comes only from stored domains.
- **SSRF protection** (`assertSafeHost` + `isBlockedIp*`): resolves the host via `dns/promises.lookup` and rejects if **any** resolved IP is reserved/private/loopback/link-local/CGNAT/benchmark/multicast/NAT64/doc-range; every redirect hop is re-validated (anti DNS-rebinding); redirects must be http(s) and same-host.
- **Status classification** (`classifyHttpStatus`): 2xx → `ok`, 4xx → `client_error`, 5xx → `server_error`; connection failure → `down`; transport/internal → `error`.
- **Failure semantics**: transport/DNS/timeout/SSRF-block failures write an **error snapshot** (`status='error'`, `error=<code>`) and may emit an `http_status_changed` event (ok→error transition); returns `{ok:false, errorCode}`.
- **Client error codes** (`HttpError.code`): `timeout`, `network`, `dns`, `blocked-redirect`, `too-many-redirects`, `invalid-url`.

## V0.7.3 monitoring error codes (machine values, snake_case, module-prefixed)

| Module | Code | Meaning (user-facing gist) |
|---|---|---|
| DNS | `dns_timeout` | DoH query timed out |
| DNS | `dns_network` | Could not reach the DNS service (incl. DoH HTTP errors) |
| DNS | `dns_invalid_response` | DNS service returned invalid data |
| DNS | `dns_resolver_error` | Resolver reported an error (SERVFAIL/REFUSED…) |
| DNS | `dns_unknown` | Unclassified failure |
| SSL | `ssl_timeout` | TLS handshake timed out |
| SSL | `ssl_network` | Connection-level network failure |
| SSL | `ssl_dns_failed` | **ENOTFOUND / EAI_AGAIN** — domain does not resolve |
| SSL | `ssl_handshake` | TLS handshake failed |
| SSL | `ssl_no_tls_service` | Nothing listening on 443 (ECONNREFUSED) |
| SSL | `ssl_invalid_cert` | Peer certificate could not be parsed |
| SSL | `ssl_unknown` | Unclassified failure |
| HTTP | `http_dns_failed` | DNS resolution failed |
| HTTP | `http_timeout` | Request timed out |
| HTTP | `http_network` | Connection failed |
| HTTP | `http_blocked_redirect` | Redirect/address blocked by SSRF safety checks (**code only — never the raw IP**) |
| HTTP | `http_too_many_redirects` | Redirect limit exceeded |
| HTTP | `http_unknown` | Unclassified failure |

**Mapping**: `src/lib/monitoring/error-classifier.ts` (pure functions `classifyDnsError/classifySslError/classifyHttpError`). Anything that is not a recognized client error → `*_unknown`. Legacy DB values (old English sentences) are not codes → UI falls back to the generic per-module unavailable message.

**Where codes appear**: action responses (`errorCode`), snapshot `error` column (SSL/HTTP), button/alert rendering (via `errorMessage(code, dict)` in `src/lib/i18n/display.ts`). Raw `Error.message` appears **only** in server logs (`[dns]/[ssl]/[http] check failed …`).
