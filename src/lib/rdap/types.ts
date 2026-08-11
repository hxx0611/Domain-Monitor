/**
 * RDAP types.
 *
 * `RawRdapResponse` mirrors the (loose) shape of RDAP JSON as served by
 * registries. `RdapDomainData` is Domain Monitor's own normalized structure.
 * The two are intentionally kept separate — database schema depends only on
 * `RdapDomainData`.
 */

/** Normalized domain data produced by the RDAP parser. */
export interface RdapDomainData {
  domainName: string;
  registrar?: string;
  /** ISO 8601 */
  registrationDate?: string;
  /** ISO 8601 */
  expirationDate?: string;
  /** ISO 8601 */
  updatedDate?: string;
  status: string[];
  nameservers: string[];
}

// --- Raw RDAP JSON (loosely typed, never `any`) ---

export interface RawRdapEvent {
  eventAction?: string;
  eventDate?: string;
}

export interface RawRdapNameserver {
  ldhName?: string;
}

export interface RawRdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}

export interface RawRdapResponse {
  ldhName?: string;
  domainName?: string;
  events?: RawRdapEvent[];
  status?: string[];
  nameservers?: RawRdapNameserver[];
  entities?: RawRdapEntity[];
}
