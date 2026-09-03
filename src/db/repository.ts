/**
 * Domain Monitor — Database Repository Contract (Phase 14C-1).
 *
 * Public API for all database operations. Every repository method is async
 * (Promise<T>). The two implementations are:
 *
 *   - SQLiteRepository (better-sqlite3 + drizzle-orm/better-sqlite3)
 *   - D1Repository      (drizzle-orm/d1)
 *
 * Business-layer code must NEVER import better-sqlite3, D1, or drizzle
 * types directly. Business code obtains a repository through the runtime
 * resolver `getRepository()` from `@/lib/runtime/repository` (Phase
 * 14C-2C); the adapters are wired by the Node/Cloudflare runtimes.
 *
 * @file
 */

import "server-only";

// ────────────────────────────────────────────────────────────────────────────
// Domain types re-exported from feature modules (type-only, erased at compile)
// ────────────────────────────────────────────────────────────────────────────
import type {
  Domain,
  ExpirationReminder,
  NotificationChannel,
  NotificationEventRow,
  NotificationDelivery,
  AdminSettingsRow,
} from "@/db/schema";
import type { DomainWithRdap } from "@/lib/domains/repository";
import type { DnsSnapshotWithRecords } from "@/lib/dns/repository";
import type { DnsRecord } from "@/lib/dns/types";
import type { HttpSnapshot } from "@/lib/http/types";
import type { NewHttpCheckData } from "@/lib/http/repository";
import type { SslSnapshotWithCertificate, NewSslCheckData } from "@/lib/ssl/repository";
import type { NotificationRuleFilter, NotificationEvent } from "@/lib/notifications/types";
import type {
  RuleWithChannelRow,
  DeliveryWithDetailsRow,
  NewRuleFields,
} from "@/lib/notifications/repository";
import type { RdapDomainData, RdapOwnership } from "@/lib/rdap";

// ────────────────────────────────────────────────────────────────────────────
// Repository contract
// ────────────────────────────────────────────────────────────────────────────

export interface Repository {
  // ── Domains ──────────────────────────────────────────────────────────────
  getDomains(): Promise<DomainWithRdap[]>;
  getDomainById(id: number): Promise<DomainWithRdap | undefined>;
  getDomainByHostname(hostname: string): Promise<Domain | undefined>;
  createDomain(
    hostname: string,
    fields?: {
      expirationSource?: "rdap" | "manual";
      registrationDate?: string | null;
      expirationDate?: string | null;
      registrationProvider?: string | null;
      registrationProviderUrl?: string | null;
    },
  ): Promise<Domain | undefined>;
  updateDomain(
    id: number,
    fields: {
      expirationSource: "rdap" | "manual";
      registrationDate?: string | null;
      expirationDate?: string | null;
      registrationProvider?: string | null;
      registrationProviderUrl?: string | null;
    },
  ): Promise<boolean>;
  deleteDomain(id: number): Promise<boolean>;
  updateDomainRdap(id: number, data: RdapDomainData, ownership: RdapOwnership): Promise<boolean>;

  // ── Expiration reminders ─────────────────────────────────────────────────
  getExpirationReminders(domainId: number): Promise<ExpirationReminder[]>;
  setExpirationReminders(domainId: number, days: number[]): Promise<number>;
  getAllExpirationReminders(): Promise<{ domainId: number; daysBefore: number }[]>;

  /** Domains whose expirationDate IS NOT NULL (for reminder evaluation). */
  getDomainsWithExpiration(): Promise<Domain[]>;

  // ── DNS ──────────────────────────────────────────────────────────────────
  createDnsSnapshot(
    domainId: number,
    records: DnsRecord[],
    events?: NotificationEvent[],
  ): Promise<number>;
  getLatestDnsSnapshot(domainId: number): Promise<DnsSnapshotWithRecords | undefined>;
  getDnsSnapshots(domainId: number, limit: number): Promise<DnsSnapshotWithRecords[]>;

  // ── HTTP ─────────────────────────────────────────────────────────────────
  createHttpSnapshot(data: NewHttpCheckData, events?: NotificationEvent[]): Promise<number>;
  getLatestHttpSnapshot(domainId: number): Promise<HttpSnapshot | undefined>;
  getHttpHistory(domainId: number, limit: number): Promise<HttpSnapshot[]>;

  // ── SSL ──────────────────────────────────────────────────────────────────
  createSslSnapshot(data: NewSslCheckData, events?: NotificationEvent[]): Promise<number>;
  getLatestSslSnapshot(domainId: number): Promise<SslSnapshotWithCertificate | undefined>;
  getSslHistory(domainId: number, limit: number): Promise<SslSnapshotWithCertificate[]>;

  // ── Notification events ──────────────────────────────────────────────────
  insertNotificationEvents(events: NotificationEvent[]): Promise<(number | null)[]>;

  /**
   * Insert events and immediately generate pending deliveries for the ones
   * that were actually inserted, atomically (dedup hits never re-generate).
   * Returns the ids of the events that received (or kept) deliveries.
   */
  insertEventsAndGenerateDeliveries(events: NotificationEvent[]): Promise<number[]>;

  // ── Notification channels ────────────────────────────────────────────────
  getChannels(): Promise<NotificationChannel[]>;
  getChannel(channelId: number): Promise<NotificationChannel | undefined>;
  createChannel(type: string, name: string, config: string): Promise<number>;
  updateChannel(channelId: number, fields: { name?: string; config?: string }): Promise<boolean>;
  setChannelEnabled(channelId: number, enabled: boolean): Promise<boolean>;
  deleteChannel(channelId: number): Promise<boolean>;

  // ── Notification rules ───────────────────────────────────────────────────
  getEnabledRules(): Promise<NotificationRuleFilter[]>;
  getRules(): Promise<RuleWithChannelRow[]>;
  createRule(fields: NewRuleFields): Promise<number>;
  updateRule(ruleId: number, fields: Partial<NewRuleFields>): Promise<boolean>;
  setRuleEnabled(ruleId: number, enabled: boolean): Promise<boolean>;
  deleteRule(ruleId: number): Promise<boolean>;

  // ── Notification deliveries (state machine) ─────────────────────────────
  createDelivery(eventId: number, channelId: number): Promise<number | null>;
  getDelivery(deliveryId: number): Promise<NotificationDelivery | undefined>;
  getEvent(eventId: number): Promise<NotificationEventRow | undefined>;
  getEventDeliveries(eventId: number): Promise<NotificationDelivery[]>;
  getPendingDeliveries(limit: number): Promise<NotificationDelivery[]>;
  getDeliveriesWithDetails(): Promise<DeliveryWithDetailsRow[]>;
  claimPendingDelivery(deliveryId: number, now?: Date): Promise<boolean>;
  markDeliverySent(deliveryId: number, now?: Date): Promise<boolean>;
  markDeliveryFailed(deliveryId: number, error: string): Promise<boolean>;
  retryDelivery(deliveryId: number): Promise<boolean>;
  recoverStaleSending(staleAfterMs?: number, now?: Date): Promise<number>;

  // ── Notification secrets ─────────────────────────────────────────────────
  setChannelSecret(channelId: number, key: string, value: string | null): Promise<void>;
  getChannelSecret(channelId: number, key: string): Promise<string | null>;
  hasChannelSecret(channelId: number, key: string): Promise<boolean>;

  // ── Admin settings ───────────────────────────────────────────────────────
  getAdminRow(): Promise<AdminSettingsRow | undefined>;
  insertAdminRow(values: {
    passwordHash: string;
    recoveryCodeHash: string;
    sessionSecret: string;
    encryptionKey?: string;
  }): Promise<void>;
  updateAdminRow(
    id: number,
    values: Partial<{
      passwordHash: string | null;
      recoveryCodeHash: string | null;
      sessionSecret: string;
      encryptionKey: string;
      updatedAt: Date;
    }>,
  ): Promise<void>;
  isAdminConfigured(): Promise<boolean>;
  getSessionSecret(): Promise<string>;
  /** Encryption key from the admin_settings row (ENCRYPTION_KEY env wins). */
  getEncryptionKey(): Promise<string>;
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime wiring (14C-2C)
// ────────────────────────────────────────────────────────────────────────────
//
// This module is the pure Repository CONTRACT. It must stay import-safe for
// the Cloudflare worker runtime: it does NOT import `@/db`, the SQLite
// adapter, the D1 adapter, or better-sqlite3, and it does NOT create any
// singleton. Business code obtains a repository through the runtime
// resolver `getRepository()` in `@/lib/runtime/repository`:
//
//   Node (self-hosted)   → lazy SQLite singleton (`@/db/node-singleton`)
//   Cloudflare (worker)  → request-scoped `createD1Repository(env.DB)`
//
// Tests that need their own repository instance should call
// `createSQLiteRepository(createTestDb())` instead of a singleton.
