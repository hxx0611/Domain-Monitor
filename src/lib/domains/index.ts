// Domain feature module — server-facing aggregator.
//
// Client Components must import from `./actions` directly (the "use server"
// module is client-safe); this barrel re-exports filters and providers only.

export {
  createDomainAction,
  deleteDomainAction,
  refreshRdapAction,
  updateDomainAction,
} from "./actions";
export type { DomainActionResult, DomainFields } from "./actions";
export {
  getRegistrationProvider,
  REGISTRATION_PROVIDERS,
  validateManagementUrl,
} from "./providers";
export { normalizeHostname, validateManualDates } from "./validation";
export type { ValidationResult } from "./validation";
