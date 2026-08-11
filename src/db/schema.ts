import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
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

export const schema = { domains };

export type Schema = typeof schema;
