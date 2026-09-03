# Phase 14C-5 — SSL Blocker: Empirical Workerd Findings

## Summary (empirically verified in Cloudflare workerd `nodejs_compat`)

Cloudflare **cannot** read the remote peer X509 certificate. Only TLS
*reachability* (handshake) is possible.

| Probe | Result |
|---|---|
| `import tls from "node:tls"` | OK (module available) |
| `tls.connect(host, port, servername)` | OK — `secureConnect: true`, `encrypted: true` |
| `socket.getPeerX509Certificate()` | **THROWS**: `TLSSocket.getPeerX509Certificate is not implemented` |
| `socket.getProtocol()` | returns `"n/a"` (not implemented) |
| `rejectUnauthorized` option | **THROWS**: `The options.rejectUnauthorized option is not implemented` |
| certificate `subject`/`issuer`/`validTo`/`SAN`/`fingerprint256`/`serialNumber` | **UNAVAILABLE** (no API) |

## What this means

The Node SSL monitor reads: `fingerprint256`, `subject`, `issuer`, `validFrom`,
`validTo` (expiry), `serialNumber`, `subjectAltName` (SAN), `ca` (self-signed),
`checkHost(hostname)` (hostname match/mismatch). The Cloudflare Worker obtains
**none** of these.

- **Expiry monitoring** (validTo → "expired"/"expires_soon") = **IMPOSSIBLE**.
- **Hostname mismatch detection** (checkHost → "mismatch") = **IMPOSSIBLE**.
- **Self-signed detection** (ca) = **IMPOSSIBLE**.
- **TLS reachability** (connect to :443, distinguish no-tls-service / dns-failed) = **POSSIBLE**.

## Decision

**Cloudflare SSL capability = PARTIAL (Node-monitor required for cert fields).**

The Worker can only confirm "HTTPS/TLS is reachable on :443", NOT certificate
identity/expiry/mismatch. Therefore:

- **Do NOT delete the Node SSL monitor.** It remains the source of truth for
  certificate validity classification (expiry, mismatch, Self-signed).
- The Cloudflare Worker SSL path (if any) is a PARTIAL/degraded HTTPS
  availability check — NOT a drop-in replacement.

Per task instruction: `SSL Worker capability = PARTIAL`, and we EXPLICITLY
record "不删除 Node SSL monitor，Cloudflare 版本暂为 PARTIAL".
