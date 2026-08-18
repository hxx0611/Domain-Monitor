// RDAP feature module — server-side only.
// UI code must never call RDAP directly; it reads from the repository and
// triggers queries through server actions.

export { queryRdap, queryRdapWithFallback, getRdapLookupCandidates } from "./service";
export type { RdapQueryOptions, RdapOwnership, RdapOwnershipResult } from "./service";
export { RdapError } from "./client";
export type { RdapErrorCode } from "./client";
export { parseRdapDomainResponse, normalizeDate } from "./parser";
export { buildSuffixMap, findRdapEndpoint, loadBootstrapMap } from "./bootstrap";
export type { RdapDomainData } from "./types";
