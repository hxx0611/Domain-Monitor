import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import { InferSelectModel, InferInsertModel } from "drizzle-orm";

/**
 * Monitored domains.
 *
 * `createdAt` / `updatedAt` are stored as Unix timestamps (seconds) via
 * Drizzle's `timestamp` mode and exposed as `Date` objects in TypeScript.
 *
 * RDAP fields (V0.2+):
 * - `registrar`, `registrationDate`, `expirationDate`, `updatedDate` are
 *   stored as ISO 8601 strings (or NULL when unknown).
 * - `nameservers` / `rdapStatus` are stored as JSON-encoded string arrays.
 *   They are deliberately kept in the same table (no normalization yet —
 *   a single domain list has no need for separate tables at this stage).
 * - `rdapUpdatedAt` records when the RDAP data was last fetched, NOT the
 *   domain's own last-updated time (that is `updatedDate`).
 */
export const domains = sqliteTable("domains", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostname: text("hostname").notNull().unique(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  // RDAP data (V0.2)
  registrar: text("registrar"),
  registrationDate: text("registration_date"),
  expirationDate: text("expiration_date"),
  updatedDate: text("updated_date"),
  rdapUpdatedAt: integer("rdap_updated_at", { mode: "timestamp" }),
  nameservers: text("nameservers"),
  rdapStatus: text("rdap_status"),
});

export type Domain = InferSelectModel<typeof domains>;
export type NewDomain = InferInsertModel<typeof domains>;

/**
 * DNS monitoring (V0.3).
 *
 * Every successful DNS check stores one row in `dnsSnapshots`; the records
 * observed at that moment live in `dnsRecords` (one row per record). The
 * domain can have many snapshots — history is deliberately kept.
 *
 * `checkedAt` follows the same convention as the rest of the schema:
 * unix seconds via Drizzle's `timestamp` mode.
 *
 * Records are stored structurally (not as a JSON blob) so that diffs,
 * history and record-level queries stay cheap and indexable.
 */
export const dnsSnapshots = sqliteTable(
  "dns_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    domainId: integer("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    checkedAt: integer("checked_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("dns_snapshots_domain_id_idx").on(table.domainId)],
);

export const dnsRecords = sqliteTable(
  "dns_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => dnsSnapshots.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** Owner name, canonicalized (lowercase, no trailing dot). */
    name: text("name").notNull(),
    /** Canonicalized record data. For MX this is the exchange hostname. */
    value: text("value").notNull(),
    /** MX preference only; NULL for every other record type. */
    priority: integer("priority"),
    /** Saved for display; deliberately excluded from change detection. */
    ttl: integer("ttl"),
  },
  (table) => [index("dns_records_snapshot_id_idx").on(table.snapshotId)],
);

export type DnsSnapshot = InferSelectModel<typeof dnsSnapshots>;
export type NewDnsSnapshot = InferInsertModel<typeof dnsSnapshots>;
export type DnsRecordRow = InferSelectModel<typeof dnsRecords>;
export type NewDnsRecord = InferInsertModel<typeof dnsRecords>;

export const schema = { domains, dnsSnapshots, dnsRecords };

export type Schema = typeof schema;
