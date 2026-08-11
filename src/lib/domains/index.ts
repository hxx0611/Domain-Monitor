// Domain feature module — server-facing aggregator.
//
// Client Components must import from `./actions` directly (the "use server"
// module is client-safe); this barrel re-exports the repository too, which
// is guarded by `server-only` and must never be pulled into a client bundle.

export { createDomainAction, deleteDomainAction, refreshRdapAction } from "./actions";
export type { DomainActionResult } from "./actions";
export { getDomains, getDomainById } from "./repository";
export type { DomainWithRdap } from "./repository";
export { normalizeHostname } from "./validation";
export type { ValidationResult } from "./validation";
