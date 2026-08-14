import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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

/**
 * SSL certificate monitoring (V0.4).
 *
 * Every successful TLS check stores one row in `sslSnapshots`; the leaf
 * certificate observed at that moment lives in `sslCertificates` (one row
 * per snapshot). The domain can have many snapshots — history is kept,
 * mirroring the DNS snapshot design.
 *
 * `fingerprint256` is the certificate identity key used for change
 * detection: a different fingerprint means the certificate was replaced.
 * `status` is the normalized check outcome (see src/lib/ssl/types.ts);
 * `error` carries a user-safe message when status is 'error'.
 */
export const sslSnapshots = sqliteTable(
  "ssl_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    domainId: integer("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    checkedAt: integer("checked_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    tlsVersion: text("tls_version"),
    cipherName: text("cipher_name"),
    status: text("status").notNull(),
    error: text("error"),
  },
  (table) => [index("ssl_snapshots_domain_id_idx").on(table.domainId)],
);

export const sslCertificates = sqliteTable(
  "ssl_certificates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => sslSnapshots.id, { onDelete: "cascade" }),
    fingerprint256: text("fingerprint256").notNull(),
    subject: text("subject"),
    issuer: text("issuer"),
    /** ISO 8601 (UTC). */
    validFrom: text("valid_from"),
    /** ISO 8601 (UTC). */
    validTo: text("valid_to"),
    serialNumber: text("serial_number"),
    /** JSON-encoded string array of SAN entries. */
    san: text("san"),
    /** 0/1 — certificate is self-signed (ca flag). */
    isSelfSigned: integer("is_self_signed"),
    /** 0/1 — the certificate's SAN covers the queried hostname. */
    hostnameMatched: integer("hostname_matched"),
  },
  (table) => [index("ssl_certificates_snapshot_id_idx").on(table.snapshotId)],
);

export type SslSnapshot = InferSelectModel<typeof sslSnapshots>;
export type NewSslSnapshot = InferInsertModel<typeof sslSnapshots>;
export type SslCertificateRow = InferSelectModel<typeof sslCertificates>;
export type NewSslCertificate = InferInsertModel<typeof sslCertificates>;

/**
 * HTTP health checks (V0.5).
 *
 * Every HTTP check stores one row in `httpSnapshots`. Unlike DNS and SSL,
 * an HTTP check produces scalar values (status code, response time, redirect
 * metadata) rather than a collection or object, so a single table suffices.
 *
 * `status` is the normalized outcome (see src/lib/http/types.ts):
 * - ok / client_error / server_error — a response was received
 * - down — connection failed (no reachable service)
 * - error — transport error or internal failure (user-safe message in `error`)
 */
export const httpSnapshots = sqliteTable(
  "http_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    domainId: integer("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    checkedAt: integer("checked_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    status: text("status").notNull(),
    /** Final HTTP status code (present when a response was received). */
    httpStatus: integer("http_status"),
    /** Total request time in milliseconds. */
    responseTimeMs: integer("response_time_ms"),
    /** 0/1 — whether any redirect was followed. */
    redirected: integer("redirected"),
    /** Number of redirects followed (0 when none). */
    redirectCount: integer("redirect_count"),
    /** Final URL after redirects. */
    finalUrl: text("final_url"),
    /** User-safe message when status is "error". */
    error: text("error"),
  },
  (table) => [index("http_snapshots_domain_id_idx").on(table.domainId)],
);

export type HttpSnapshot = InferSelectModel<typeof httpSnapshots>;
export type NewHttpSnapshot = InferInsertModel<typeof httpSnapshots>;

/**
 * Notifications (V0.6).
 *
 * Event → Rule → Delivery pipeline:
 * - `notificationEvents` is the unified, deduplicated event stream derived
 *   from DNS / SSL / HTTP snapshot diffs. `dedupKey` uniquely identifies
 *   one concrete state transition (e.g. http:5:status_changed:ok:down) so
 *   the same transition is never recorded twice.
 * - `notificationChannels` are delivery endpoints. V0.6 supports email and
 *   webhook only; webhook secrets are referenced by key, never stored raw
 *   in the config JSON.
 * - `notificationRules` map events to channels (source / event type /
 *   domain filters; null = match all).
 * - `notificationDeliveries` record per-channel send attempts for an event.
 *
 * Phase 1 defines the data boundary only — no sending logic yet.
 */
export const notificationChannels = sqliteTable("notification_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** "email" | "webhook". */
  type: text("type").notNull(),
  name: text("name").notNull(),
  /** JSON config: email → {"to": ...}; webhook → {"url": ..., "secretRef": ...}. */
  config: text("config").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const notificationRules = sqliteTable("notification_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  channelId: integer("channel_id")
    .notNull()
    .references(() => notificationChannels.id, { onDelete: "cascade" }),
  /** null = all sources. */
  source: text("source"),
  /** null = all event types. */
  eventType: text("event_type"),
  /** null = all domains. */
  domainId: integer("domain_id").references(() => domains.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const notificationEvents = sqliteTable(
  "notification_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    domainId: integer("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** "dns" | "ssl" | "http". */
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    /** JSON-encoded previous state (null when none). */
    previousState: text("previous_state"),
    /** JSON-encoded current state (null when none). */
    currentState: text("current_state"),
    /** Stable identity of one state transition — unique per event. */
    dedupKey: text("dedup_key").notNull().unique(),
    occurredAt: integer("occurred_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("notification_events_domain_id_idx").on(table.domainId)],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    /** "pending" | "sending" | "sent" | "failed". */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Set when claimed (pending → sending); used to recover stale sends. */
    claimedAt: integer("claimed_at", { mode: "timestamp" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  },
  (table) => [
    index("notification_deliveries_event_id_idx").on(table.eventId),
    // One pending/sent/failed delivery per event+channel — multiple rules
    // matching the same channel must never create duplicates.
    uniqueIndex("notification_deliveries_event_channel_unique").on(table.eventId, table.channelId),
  ],
);

export type NotificationChannel = InferSelectModel<typeof notificationChannels>;
export type NewNotificationChannel = InferInsertModel<typeof notificationChannels>;
export type NotificationRule = InferSelectModel<typeof notificationRules>;
export type NewNotificationRule = InferInsertModel<typeof notificationRules>;
export type NotificationEventRow = InferSelectModel<typeof notificationEvents>;
export type NewNotificationEvent = InferInsertModel<typeof notificationEvents>;
export type NotificationDelivery = InferSelectModel<typeof notificationDeliveries>;
export type NewNotificationDelivery = InferInsertModel<typeof notificationDeliveries>;

export const schema = {
  domains,
  dnsSnapshots,
  dnsRecords,
  sslSnapshots,
  sslCertificates,
  httpSnapshots,
  notificationChannels,
  notificationRules,
  notificationEvents,
  notificationDeliveries,
};

export type Schema = typeof schema;
