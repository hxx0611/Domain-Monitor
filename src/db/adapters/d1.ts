/**
 * D1 runtime adapter (Phase 14C-1 / 14C-2B).
 *
 * Implements the Repository contract on Cloudflare D1:
 * drizzle-orm/d1, fully ASYNC driver.
 *
 * Key D1 differences from better-sqlite3 handled here:
 *   - every statement is awaited (async API)
 *   - `run()` returns `{ meta: { changes, last_row_id, ... } }` — the
 *     changed-row count lives at `meta.changes`, NOT `.changes`
 *   - D1 DOES NOT allow `BEGIN TRANSACTION` / `SAVEPOINT` (drizzle's D1
 *     session transaction sends BEGIN and is rejected by the runtime:
 *     "use state.storage.transaction() … instead"). Multi-statement
 *     atomicity is therefore expressed with `D1Database.batch()`, which
 *     executes all statements as ONE atomic unit (all-or-nothing).
 *   - batch statements cannot read rows written by earlier statements in
 *     the same batch (no read-your-writes inside a batch). Every
 *     operation that needs an auto-increment id from the same atomic unit
 *     therefore pre-allocates it deterministically
 *     (`SELECT COALESCE(MAX(id),0)+1 …`) BEFORE building the batch, and
 *     inserts with explicit ids. Rules / channels / dedup keys are also
 *     pre-read before the batch. See `buildEventBatch()`.
 *   - the notification event → delivery pipeline lives inside the same
 *     batch as the snapshot writes so snapshot + events + deliveries stay
 *     atomic (matching SQLite transaction semantics).
 *
 * Business-layer code must never import this module directly — use the
 * `Repository` contract / factory from `@/db/repository`.
 */

import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";
import {
  adminSettings,
  domains,
  dnsRecords,
  dnsSnapshots,
  expirationReminders,
  httpSnapshots,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
  notificationSecrets,
  schema,
  sslCertificates,
  sslSnapshots,
  type Domain,
  type NotificationChannel,
  type NotificationDelivery,
  type Schema,
} from "@/db/schema";
import type { Repository } from "../repository";
import type { D1BindingLike } from "./types";
import { matchRules } from "@/lib/notifications/rules";
import type { NotificationEvent, NotificationRuleFilter } from "@/lib/notifications/types";
import type {
  NewRuleFields,
  RuleWithChannelRow,
  DeliveryWithDetailsRow,
} from "@/lib/notifications/repository";
import type { DnsRecord } from "@/lib/dns/types";
import type { HttpStatus } from "@/lib/http/types";
import type { SslCertificate, SslStatus } from "@/lib/ssl/types";
import {
  decryptSecretWithKey,
  encryptSecretWithKey,
  getEncryptionKey,
} from "@/lib/notifications/encryption";

function decodeStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** D1 implementation of the Repository contract. */
export class D1Repository implements Repository {
  private readonly db: DrizzleD1Database<Schema>;

  constructor(binding: D1BindingLike) {
    this.db = drizzle(binding as unknown as AnyD1Database, { schema });
  }

  // ── Domains ──────────────────────────────────────────────────────────────
  async getDomains() {
    const rows = await this.db.select().from(domains).orderBy(domains.createdAt).all();
    return rows.map((row) => ({
      ...row,
      nameservers: decodeStringArray(row.nameservers),
      rdapStatus: decodeStringArray(row.rdapStatus),
    }));
  }
  async getDomainById(id: number) {
    const row = await this.db.select().from(domains).where(eq(domains.id, id)).get();
    if (!row) {
      return undefined;
    }
    return {
      ...row,
      nameservers: decodeStringArray(row.nameservers),
      rdapStatus: decodeStringArray(row.rdapStatus),
    };
  }
  async getDomainByHostname(hostname: string) {
    return this.db.select().from(domains).where(eq(domains.hostname, hostname)).get();
  }
  async createDomain(
    hostname: string,
    fields?: {
      expirationSource?: "rdap" | "manual";
      registrationDate?: string | null;
      expirationDate?: string | null;
      registrationProvider?: string | null;
      registrationProviderUrl?: string | null;
    },
  ): Promise<Domain | undefined> {
    const existing = await this.getDomainByHostname(hostname);
    if (existing) {
      return undefined;
    }
    const manual = fields?.expirationSource === "manual";
    const row = await this.db
      .insert(domains)
      .values({
        hostname,
        expirationSource: manual ? "manual" : "rdap",
        registrationDate: manual ? (fields?.registrationDate ?? null) : null,
        expirationDate: manual ? (fields?.expirationDate ?? null) : null,
        registrationProvider: fields?.registrationProvider ?? null,
        registrationProviderUrl: fields?.registrationProviderUrl ?? null,
      })
      .returning()
      .get();
    return row;
  }
  async updateDomain(
    id: number,
    fields: {
      expirationSource: "rdap" | "manual";
      registrationDate?: string | null;
      expirationDate?: string | null;
      registrationProvider?: string | null;
      registrationProviderUrl?: string | null;
    },
  ): Promise<boolean> {
    const manual = fields.expirationSource === "manual";
    const row = await this.db
      .update(domains)
      .set({
        expirationSource: manual ? "manual" : "rdap",
        registrationDate: manual ? (fields.registrationDate ?? null) : null,
        expirationDate: manual ? (fields.expirationDate ?? null) : null,
        registrationProvider: fields.registrationProvider ?? null,
        registrationProviderUrl: fields.registrationProviderUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(domains.id, id))
      .returning({ id: domains.id })
      .get();
    return row !== undefined;
  }
  async deleteDomain(id: number): Promise<boolean> {
    const row = await this.db
      .delete(domains)
      .where(eq(domains.id, id))
      .returning({ id: domains.id })
      .get();
    return row !== undefined;
  }
  async updateDomainRdap(
    id: number,
    data: Parameters<Repository["updateDomainRdap"]>[1],
    ownership: Parameters<Repository["updateDomainRdap"]>[2],
  ): Promise<boolean> {
    const current = await this.db.select().from(domains).where(eq(domains.id, id)).get();
    if (!current) {
      return false;
    }
    const manual = current.expirationSource === "manual";

    if (ownership !== "exact") {
      const row = await this.db
        .update(domains)
        .set({
          registrar: null,
          registrationDate: manual ? current.registrationDate : null,
          expirationDate: manual ? current.expirationDate : null,
          updatedDate: null,
          rdapUpdatedAt: new Date(),
          nameservers: "[]",
          rdapStatus: JSON.stringify(["no-object"]),
        })
        .where(eq(domains.id, id))
        .returning({ id: domains.id })
        .get();
      return row !== undefined;
    }

    const row = await this.db
      .update(domains)
      .set({
        registrar: data.registrar ?? null,
        registrationDate: manual ? current.registrationDate : (data.registrationDate ?? null),
        expirationDate: manual ? current.expirationDate : (data.expirationDate ?? null),
        updatedDate: data.updatedDate ?? null,
        rdapUpdatedAt: new Date(),
        nameservers: JSON.stringify(data.nameservers),
        rdapStatus: JSON.stringify(data.status),
      })
      .where(eq(domains.id, id))
      .returning({ id: domains.id })
      .get();
    return row !== undefined;
  }

  // ── Expiration reminders ─────────────────────────────────────────────────
  async getExpirationReminders(domainId: number) {
    return this.db
      .select()
      .from(expirationReminders)
      .where(eq(expirationReminders.domainId, domainId))
      .orderBy(expirationReminders.daysBefore)
      .all();
  }
  async setExpirationReminders(domainId: number, days: number[]): Promise<number> {
    // One atomic D1 batch: delete stale + insert fresh reminders.
    // A duplicate days_before (UNIQUE(domain_id, days_before)) fails the
    // whole batch, mirroring the SQLite transaction semantics.
    const items: BatchItem<"sqlite">[] = [
      this.db.delete(expirationReminders).where(eq(expirationReminders.domainId, domainId)),
    ];
    if (days.length > 0) {
      items.push(
        this.db
          .insert(expirationReminders)
          .values(days.map((daysBefore) => ({ domainId, daysBefore }))),
      );
    }
    await this.runBatch(items);
    return days.length;
  }
  async getAllExpirationReminders() {
    return this.db
      .select({
        domainId: expirationReminders.domainId,
        daysBefore: expirationReminders.daysBefore,
      })
      .from(expirationReminders)
      .all();
  }
  async getDomainsWithExpiration(): Promise<Domain[]> {
    return this.db.select().from(domains).where(isNotNull(domains.expirationDate)).all();
  }

  // ── DNS ──────────────────────────────────────────────────────────────────
  async createDnsSnapshot(
    domainId: number,
    records: DnsRecord[],
    events: NotificationEvent[] = [],
  ): Promise<number> {
    // One atomic D1 batch: snapshot + records + events + deliveries.
    // The snapshot id is pre-allocated (batch statements cannot read their
    // own writes), so the record INSERTs can reference it inside the batch.
    const snapshotId = await this.nextId("dns_snapshots");
    const eventBatch = await this.buildEventBatch(events);
    const items: BatchItem<"sqlite">[] = [
      this.db.insert(dnsSnapshots).values({ id: snapshotId, domainId }),
    ];
    if (records.length > 0) {
      items.push(
        this.db.insert(dnsRecords).values(
          records.map((record) => ({
            snapshotId,
            type: record.type,
            name: record.name,
            value: record.value,
            priority: record.priority ?? null,
            ttl: record.ttl ?? null,
          })),
        ),
      );
    }
    items.push(...eventBatch.items);
    await this.runBatch(items);
    return snapshotId;
  }
  async getLatestDnsSnapshot(domainId: number) {
    const snapshot = await this.db
      .select()
      .from(dnsSnapshots)
      .where(eq(dnsSnapshots.domainId, domainId))
      .orderBy(desc(dnsSnapshots.checkedAt), desc(dnsSnapshots.id))
      .limit(1)
      .get();
    if (!snapshot) {
      return undefined;
    }
    return { ...snapshot, records: await this.getRecordsForSnapshot(snapshot.id) };
  }
  async getDnsSnapshots(domainId: number, limit: number) {
    const snapshots = await this.db
      .select()
      .from(dnsSnapshots)
      .where(eq(dnsSnapshots.domainId, domainId))
      .orderBy(desc(dnsSnapshots.checkedAt), desc(dnsSnapshots.id))
      .limit(limit)
      .all();
    if (snapshots.length === 0) {
      return [];
    }
    const ids = snapshots.map((s) => s.id);
    const rows = await this.db
      .select()
      .from(dnsRecords)
      .where(inArray(dnsRecords.snapshotId, ids))
      .all();
    const bySnapshot = new Map<number, DnsRecord[]>();
    for (const row of rows) {
      const list = bySnapshot.get(row.snapshotId) ?? [];
      list.push({
        type: row.type as DnsRecord["type"],
        name: row.name,
        value: row.value,
        ...(row.priority !== null ? { priority: row.priority } : {}),
        ...(row.ttl !== null ? { ttl: row.ttl } : {}),
      });
      bySnapshot.set(row.snapshotId, list);
    }
    return snapshots.map((s) => ({ ...s, records: bySnapshot.get(s.id) ?? [] }));
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  async createHttpSnapshot(
    data: Parameters<Repository["createHttpSnapshot"]>[0],
    events: NotificationEvent[] = [],
  ): Promise<number> {
    const snapshotId = await this.nextId("http_snapshots");
    const eventBatch = await this.buildEventBatch(events);
    const items: BatchItem<"sqlite">[] = [
      this.db.insert(httpSnapshots).values({
        id: snapshotId,
        domainId: data.domainId,
        status: data.status,
        httpStatus: data.httpStatus ?? null,
        responseTimeMs: data.responseTimeMs ?? null,
        redirected: data.redirected ? 1 : 0,
        redirectCount: data.redirectCount,
        finalUrl: data.finalUrl ?? null,
        error: data.error ?? null,
      }),
    ];
    items.push(...eventBatch.items);
    await this.runBatch(items);
    return snapshotId;
  }
  async getLatestHttpSnapshot(domainId: number) {
    const snapshot = await this.db
      .select()
      .from(httpSnapshots)
      .where(eq(httpSnapshots.domainId, domainId))
      .orderBy(desc(httpSnapshots.checkedAt), desc(httpSnapshots.id))
      .limit(1)
      .get();
    return snapshot ? this.toHttpSnapshotShape(snapshot) : undefined;
  }
  async getHttpHistory(domainId: number, limit: number) {
    const snapshots = await this.db
      .select()
      .from(httpSnapshots)
      .where(eq(httpSnapshots.domainId, domainId))
      .orderBy(desc(httpSnapshots.checkedAt), desc(httpSnapshots.id))
      .limit(limit)
      .all();
    return snapshots.map((s) => this.toHttpSnapshotShape(s));
  }

  // ── SSL ──────────────────────────────────────────────────────────────────
  async createSslSnapshot(
    data: Parameters<Repository["createSslSnapshot"]>[0],
    events: NotificationEvent[] = [],
  ): Promise<number> {
    const snapshotId = await this.nextId("ssl_snapshots");
    const eventBatch = await this.buildEventBatch(events);
    const items: BatchItem<"sqlite">[] = [
      this.db.insert(sslSnapshots).values({
        id: snapshotId,
        domainId: data.domainId,
        tlsVersion: data.tlsVersion ?? null,
        cipherName: data.cipherName ?? null,
        status: data.status,
        error: data.error ?? null,
      }),
    ];
    if (data.certificate) {
      items.push(
        this.db.insert(sslCertificates).values({
          snapshotId,
          fingerprint256: data.certificate.fingerprint256,
          subject: data.certificate.subject ?? null,
          issuer: data.certificate.issuer ?? null,
          validFrom: data.certificate.validFrom ?? null,
          validTo: data.certificate.validTo ?? null,
          serialNumber: data.certificate.serialNumber ?? null,
          san: JSON.stringify(data.certificate.san),
          isSelfSigned: data.certificate.isSelfSigned ? 1 : 0,
          hostnameMatched: data.certificate.hostnameMatched ? 1 : 0,
        }),
      );
    }
    items.push(...eventBatch.items);
    await this.runBatch(items);
    return snapshotId;
  }
  async getLatestSslSnapshot(domainId: number) {
    const snapshot = await this.db
      .select()
      .from(sslSnapshots)
      .where(eq(sslSnapshots.domainId, domainId))
      .orderBy(desc(sslSnapshots.checkedAt), desc(sslSnapshots.id))
      .limit(1)
      .get();
    if (!snapshot) {
      return undefined;
    }
    return {
      ...this.toSslSnapshotShape(snapshot),
      certificate: await this.getCertificateForSnapshot(snapshot.id),
    };
  }
  async getSslHistory(domainId: number, limit: number) {
    const snapshots = await this.db
      .select()
      .from(sslSnapshots)
      .where(eq(sslSnapshots.domainId, domainId))
      .orderBy(desc(sslSnapshots.checkedAt), desc(sslSnapshots.id))
      .limit(limit)
      .all();
    if (snapshots.length === 0) {
      return [];
    }
    const ids = snapshots.map((s) => s.id);
    const rows = await this.db
      .select()
      .from(sslCertificates)
      .where(inArray(sslCertificates.snapshotId, ids))
      .all();
    const bySnapshot = new Map<number, SslCertificate | undefined>();
    for (const row of rows) {
      bySnapshot.set(row.snapshotId, this.decodeCertificateRow(row));
    }
    return snapshots.map((s) => ({
      ...this.toSslSnapshotShape(s),
      certificate: bySnapshot.get(s.id),
    }));
  }

  // ── Notification events ──────────────────────────────────────────────────
  async insertNotificationEvents(events: NotificationEvent[]): Promise<(number | null)[]> {
    return this.insertEventsTx(this.db, events);
  }
  async insertEventsAndGenerateDeliveries(events: NotificationEvent[]): Promise<number[]> {
    const eventBatch = await this.buildEventBatch(events);
    await this.runBatch(eventBatch.items);
    return eventBatch.deliveredIds;
  }

  // ── Notification channels ────────────────────────────────────────────────
  async getChannels(): Promise<NotificationChannel[]> {
    return this.db.select().from(notificationChannels).orderBy(notificationChannels.id).all();
  }
  async getChannel(channelId: number) {
    return this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .get();
  }
  async createChannel(type: string, name: string, config: string): Promise<number> {
    const row = await this.db
      .insert(notificationChannels)
      .values({ type, name, config, enabled: 1 })
      .returning({ id: notificationChannels.id })
      .get();
    return row.id;
  }
  async updateChannel(channelId: number, fields: { name?: string; config?: string }) {
    const result = await this.db
      .update(notificationChannels)
      .set(fields)
      .where(eq(notificationChannels.id, channelId))
      .run();
    return this.changes(result) > 0;
  }
  async setChannelEnabled(channelId: number, enabled: boolean) {
    const result = await this.db
      .update(notificationChannels)
      .set({ enabled: enabled ? 1 : 0 })
      .where(eq(notificationChannels.id, channelId))
      .run();
    return this.changes(result) > 0;
  }
  async deleteChannel(channelId: number) {
    const result = await this.db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .run();
    return this.changes(result) > 0;
  }

  // ── Notification rules ───────────────────────────────────────────────────
  async getEnabledRules(): Promise<NotificationRuleFilter[]> {
    const rows = await this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.enabled, 1))
      .all();
    return rows.map((row) => ({
      channelId: row.channelId,
      source: row.source as NotificationRuleFilter["source"],
      eventType: row.eventType as NotificationRuleFilter["eventType"],
      domainId: row.domainId,
      enabled: row.enabled === 1,
    }));
  }
  async getRules(): Promise<RuleWithChannelRow[]> {
    return this.db
      .select({
        id: notificationRules.id,
        name: notificationRules.name,
        channelId: notificationRules.channelId,
        source: notificationRules.source,
        eventType: notificationRules.eventType,
        domainId: notificationRules.domainId,
        enabled: notificationRules.enabled,
        createdAt: notificationRules.createdAt,
        channelName: notificationChannels.name,
        channelType: notificationChannels.type,
        hostname: domains.hostname,
      })
      .from(notificationRules)
      .leftJoin(notificationChannels, eq(notificationRules.channelId, notificationChannels.id))
      .leftJoin(domains, eq(notificationRules.domainId, domains.id))
      .orderBy(notificationRules.id)
      .all();
  }
  async createRule(fields: NewRuleFields): Promise<number> {
    const row = await this.db
      .insert(notificationRules)
      .values({ ...fields, enabled: fields.enabled ? 1 : 0 })
      .returning({ id: notificationRules.id })
      .get();
    return row.id;
  }
  async updateRule(ruleId: number, fields: Partial<NewRuleFields>) {
    const set: Record<string, unknown> = {};
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.channelId !== undefined) set.channelId = fields.channelId;
    if (fields.source !== undefined) set.source = fields.source;
    if (fields.eventType !== undefined) set.eventType = fields.eventType;
    if (fields.domainId !== undefined) set.domainId = fields.domainId;
    if (fields.enabled !== undefined) set.enabled = fields.enabled ? 1 : 0;
    const result = await this.db
      .update(notificationRules)
      .set(set)
      .where(eq(notificationRules.id, ruleId))
      .run();
    return this.changes(result) > 0;
  }
  async setRuleEnabled(ruleId: number, enabled: boolean) {
    const result = await this.db
      .update(notificationRules)
      .set({ enabled: enabled ? 1 : 0 })
      .where(eq(notificationRules.id, ruleId))
      .run();
    return this.changes(result) > 0;
  }
  async deleteRule(ruleId: number) {
    const result = await this.db
      .delete(notificationRules)
      .where(eq(notificationRules.id, ruleId))
      .run();
    return this.changes(result) > 0;
  }

  // ── Notification deliveries (state machine) ─────────────────────────────
  async createDelivery(eventId: number, channelId: number): Promise<number | null> {
    const row = await this.db
      .insert(notificationDeliveries)
      .values({ eventId, channelId, status: "pending", attempts: 0 })
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id })
      .get();
    return row?.id ?? null;
  }
  async getDelivery(deliveryId: number): Promise<NotificationDelivery | undefined> {
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
  }
  async getEvent(eventId: number) {
    return this.db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, eventId))
      .get();
  }
  async getEventDeliveries(eventId: number): Promise<NotificationDelivery[]> {
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.eventId, eventId))
      .orderBy(notificationDeliveries.id)
      .all();
  }
  async getPendingDeliveries(limit: number): Promise<NotificationDelivery[]> {
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.status, "pending"))
      .orderBy(notificationDeliveries.id)
      .limit(limit)
      .all();
  }
  async getDeliveriesWithDetails(): Promise<DeliveryWithDetailsRow[]> {
    return this.db
      .select({
        deliveryId: notificationDeliveries.id,
        eventId: notificationDeliveries.eventId,
        channelId: notificationDeliveries.channelId,
        status: notificationDeliveries.status,
        attempts: notificationDeliveries.attempts,
        error: notificationDeliveries.error,
        createdAt: notificationDeliveries.createdAt,
        claimedAt: notificationDeliveries.claimedAt,
        deliveredAt: notificationDeliveries.deliveredAt,
        channelName: notificationChannels.name,
        channelType: notificationChannels.type,
        source: notificationEvents.source,
        eventType: notificationEvents.eventType,
        occurredAt: notificationEvents.occurredAt,
        domainId: notificationEvents.domainId,
        hostname: domains.hostname,
      })
      .from(notificationDeliveries)
      .leftJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
      .leftJoin(notificationEvents, eq(notificationDeliveries.eventId, notificationEvents.id))
      .leftJoin(domains, eq(notificationEvents.domainId, domains.id))
      .orderBy(desc(notificationDeliveries.id))
      .all();
  }
  async claimPendingDelivery(deliveryId: number, now: Date = new Date()) {
    const row = await this.db
      .update(notificationDeliveries)
      .set({
        status: "sending",
        attempts: sql`${notificationDeliveries.attempts} + 1`,
        claimedAt: now,
      })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, "pending"),
        ),
      )
      .returning({ id: notificationDeliveries.id })
      .get();
    return row !== undefined;
  }
  async markDeliverySent(deliveryId: number, now: Date = new Date()) {
    const row = await this.db
      .update(notificationDeliveries)
      .set({ status: "sent", deliveredAt: now })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, "sending"),
        ),
      )
      .returning({ id: notificationDeliveries.id })
      .get();
    return row !== undefined;
  }
  async markDeliveryFailed(deliveryId: number, error: string) {
    const row = await this.db
      .update(notificationDeliveries)
      .set({ status: "failed", error })
      .where(
        and(
          eq(notificationDeliveries.id, deliveryId),
          eq(notificationDeliveries.status, "sending"),
        ),
      )
      .returning({ id: notificationDeliveries.id })
      .get();
    return row !== undefined;
  }
  async retryDelivery(deliveryId: number) {
    const row = await this.db
      .update(notificationDeliveries)
      .set({ status: "pending" })
      .where(
        and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "failed")),
      )
      .returning({ id: notificationDeliveries.id })
      .get();
    return row !== undefined;
  }
  async recoverStaleSending(staleAfterMs: number = 300_000, now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - staleAfterMs);
    const result = await this.db
      .update(notificationDeliveries)
      .set({ status: "pending" })
      .where(
        and(
          eq(notificationDeliveries.status, "sending"),
          lt(notificationDeliveries.claimedAt, cutoff),
        ),
      )
      .run();
    return this.changes(result);
  }

  // ── Notification secrets ─────────────────────────────────────────────────
  async setChannelSecret(channelId: number, key: string, value: string | null): Promise<void> {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("secret key must be a non-empty string");
    }
    if (channelId < 1 || !Number.isInteger(channelId)) {
      throw new Error("channel id must be a positive integer");
    }
    if (value === null || value === undefined || value === "") {
      await this.db
        .delete(notificationSecrets)
        .where(and(eq(notificationSecrets.channelId, channelId), eq(notificationSecrets.key, key)))
        .run();
      return;
    }
    const encryptedValue = encryptSecretWithKey(value, getEncryptionKey());
    await this.db
      .insert(notificationSecrets)
      .values({ channelId, key, encryptedValue })
      .onConflictDoUpdate({
        target: [notificationSecrets.channelId, notificationSecrets.key],
        set: { encryptedValue, updatedAt: new Date() },
      })
      .run();
  }
  async getChannelSecret(channelId: number, key: string): Promise<string | null> {
    const row = await this.db
      .select({ encryptedValue: notificationSecrets.encryptedValue })
      .from(notificationSecrets)
      .where(and(eq(notificationSecrets.channelId, channelId), eq(notificationSecrets.key, key)))
      .get();
    if (!row) {
      return null;
    }
    return decryptSecretWithKey(row.encryptedValue, getEncryptionKey());
  }
  async hasChannelSecret(channelId: number, key: string): Promise<boolean> {
    const row = await this.db
      .select({ id: notificationSecrets.id })
      .from(notificationSecrets)
      .where(and(eq(notificationSecrets.channelId, channelId), eq(notificationSecrets.key, key)))
      .get();
    return row !== undefined;
  }

  // ── Admin settings ───────────────────────────────────────────────────────
  async getAdminRow() {
    return this.db.select().from(adminSettings).limit(1).get();
  }
  async insertAdminRow(values: Parameters<Repository["insertAdminRow"]>[0]): Promise<void> {
    await this.db.insert(adminSettings).values(values).run();
  }
  async updateAdminRow(
    id: number,
    values: Parameters<Repository["updateAdminRow"]>[1],
  ): Promise<void> {
    await this.db
      .update(adminSettings)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(adminSettings.id, id))
      .run();
  }
  async isAdminConfigured(): Promise<boolean> {
    const row = await this.getAdminRow();
    return Boolean(row?.passwordHash);
  }
  async getSessionSecret(): Promise<string> {
    const envSecret = process.env.SESSION_SECRET;
    if (envSecret) {
      return envSecret;
    }
    const row = await this.getAdminRow();
    if (!row?.sessionSecret) {
      throw new Error("Admin session secret is not initialized");
    }
    return row.sessionSecret;
  }
  async getEncryptionKey(): Promise<string> {
    const envKey = process.env.ENCRYPTION_KEY;
    if (envKey) {
      return envKey;
    }
    const row = await this.getAdminRow();
    if (!row?.encryptionKey) {
      throw new Error("Admin encryption key is not initialized");
    }
    return row.encryptionKey;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Execute a set of statements as ONE atomic D1 batch.
   *
   * D1's `batch()` is all-or-nothing: if any statement fails, none are
   * applied. This is the D1 replacement for the SQLite transaction blocks.
   * An empty item list is a no-op; D1 caps a batch at 100 statements, so a
   * larger batch would silently lose atomicity if split — fail loudly
   * instead of splitting.
   */
  private async runBatch(items: BatchItem<"sqlite">[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    if (items.length > 100) {
      throw new Error(
        `D1 batch exceeds the 100-statement atomic limit (${items.length}); refusing to split`,
      );
    }
    await this.db.batch(items as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  /** Normalize D1 `run()` result to the changed-row count (meta.changes). */
  private changes(result: unknown): number {
    const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
    return typeof meta?.changes === "number" ? meta.changes : 0;
  }

  /** Insert events (D1) with ON CONFLICT DO NOTHING; returns ids aligned by position. */
  private async insertEventsTx(
    queryable: {
      insert: DrizzleD1Database<Schema>["insert"];
      select: DrizzleD1Database<Schema>["select"];
    },
    events: NotificationEvent[],
  ): Promise<(number | null)[]> {
    if (events.length === 0) {
      return [];
    }
    const rows = await queryable
      .insert(notificationEvents)
      .values(
        events.map((event) => ({
          domainId: event.domainId,
          source: event.source,
          eventType: event.eventType,
          previousState: event.previousState,
          currentState: event.currentState,
          dedupKey: event.dedupKey,
          occurredAt: event.occurredAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notificationEvents.id, dedupKey: notificationEvents.dedupKey })
      .all();
    const idByKey = new Map(rows.map((row) => [row.dedupKey, row.id]));
    return events.map((event) => idByKey.get(event.dedupKey) ?? null);
  }

  /**
   * Deterministically pre-allocate the next id for a table.
   *
   * D1 batch statements cannot read rows written by earlier statements in
   * the same batch, so any id needed by a later statement inside one
   * atomic batch must be known BEFORE the batch is built. `MAX(id)+1` is
   * read from the pre-batch snapshot; the UNIQUE/PK constraints keep the
   * batch safe: if a concurrent writer collides, the whole batch fails
   * atomically instead of leaving partial rows.
   */
  private async nextId(
    table: "dns_snapshots" | "http_snapshots" | "ssl_snapshots" | "notification_events",
  ): Promise<number> {
    const rows = await this.db.all<{ next: number }>(
      sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${sql.raw(table)}`,
    );
    return rows[0]?.next ?? 1;
  }

  /**
   * Build one atomic batch for "insert events + generate deliveries".
   *
   * All reads happen BEFORE the batch (existing dedup keys, enabled rules,
   * enabled channels) and event ids are pre-allocated deterministically so
   * the delivery INSERTs can reference them inside the same batch. The
   * whole unit (events + deliveries) commits or rolls back together —
   * never event=1 delivery=0 and never duplicate events/deliveries.
   */
  private async buildEventBatch(
    events: NotificationEvent[],
  ): Promise<{ items: BatchItem<"sqlite">[]; deliveredIds: number[] }> {
    if (events.length === 0) {
      return { items: [], deliveredIds: [] };
    }

    // Existing dedup keys (pre-batch snapshot; chunked for bind limits).
    const existingKeys = new Set<string>();
    for (let i = 0; i < events.length; i += 100) {
      const chunk = events.slice(i, i + 100).map((event) => event.dedupKey);
      const rows = await this.db
        .select({ dedupKey: notificationEvents.dedupKey })
        .from(notificationEvents)
        .where(inArray(notificationEvents.dedupKey, chunk))
        .all();
      for (const row of rows) {
        existingKeys.add(row.dedupKey);
      }
    }
    const newEvents = events.filter((event) => !existingKeys.has(event.dedupKey));
    if (newEvents.length === 0) {
      return { items: [], deliveredIds: [] };
    }

    let nextEventId = await this.nextId("notification_events");
    const eventIds = newEvents.map(() => nextEventId++);

    // Enabled rules + enabled channels (pre-batch snapshot).
    const ruleRows = await this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.enabled, 1))
      .all();
    const rules: NotificationRuleFilter[] = ruleRows.map((row) => ({
      channelId: row.channelId,
      source: row.source as NotificationRuleFilter["source"],
      eventType: row.eventType as NotificationRuleFilter["eventType"],
      domainId: row.domainId,
      enabled: row.enabled === 1,
    }));
    const channelRows = await this.db
      .select({ id: notificationChannels.id, enabled: notificationChannels.enabled })
      .from(notificationChannels)
      .all();
    const enabledChannelIds = new Set(
      channelRows.filter((row) => row.enabled === 1).map((row) => row.id),
    );

    const items: BatchItem<"sqlite">[] = [];
    const deliveredIds: number[] = [];
    newEvents.forEach((event, index) => {
      const eventId = eventIds[index];
      items.push(
        this.db
          .insert(notificationEvents)
          .values({
            id: eventId,
            domainId: event.domainId,
            source: event.source,
            eventType: event.eventType,
            previousState: event.previousState,
            currentState: event.currentState,
            dedupKey: event.dedupKey,
            occurredAt: event.occurredAt,
          })
          .onConflictDoNothing(),
      );
      const matched = matchRules(rules, event);
      const seen = new Set<number>();
      for (const rule of matched) {
        if (seen.has(rule.channelId)) {
          continue;
        }
        seen.add(rule.channelId);
        if (!enabledChannelIds.has(rule.channelId)) {
          continue;
        }
        items.push(
          this.db
            .insert(notificationDeliveries)
            .values({ eventId, channelId: rule.channelId, status: "pending", attempts: 0 })
            .onConflictDoNothing(),
        );
      }
      deliveredIds.push(eventId);
    });
    return { items, deliveredIds };
  }

  private async getRecordsForSnapshot(snapshotId: number): Promise<DnsRecord[]> {
    const rows = await this.db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.snapshotId, snapshotId))
      .all();
    return rows.map((row) => ({
      type: row.type as DnsRecord["type"],
      name: row.name,
      value: row.value,
      ...(row.priority !== null ? { priority: row.priority } : {}),
      ...(row.ttl !== null ? { ttl: row.ttl } : {}),
    }));
  }

  private toHttpSnapshotShape(snapshot: {
    id: number;
    domainId: number;
    checkedAt: Date;
    status: string;
    httpStatus: number | null;
    responseTimeMs: number | null;
    redirected: number | null;
    redirectCount: number | null;
    finalUrl: string | null;
    error: string | null;
  }) {
    return {
      id: snapshot.id,
      domainId: snapshot.domainId,
      checkedAt: snapshot.checkedAt,
      status: snapshot.status as HttpStatus,
      httpStatus: snapshot.httpStatus ?? undefined,
      responseTimeMs: snapshot.responseTimeMs ?? undefined,
      redirected: snapshot.redirected === 1,
      redirectCount: snapshot.redirectCount ?? 0,
      finalUrl: snapshot.finalUrl ?? undefined,
      error: snapshot.error ?? undefined,
    };
  }

  private toSslSnapshotShape(snapshot: {
    id: number;
    domainId: number;
    checkedAt: Date;
    tlsVersion: string | null;
    cipherName: string | null;
    status: string;
    error: string | null;
  }) {
    return {
      id: snapshot.id,
      domainId: snapshot.domainId,
      checkedAt: snapshot.checkedAt,
      tlsVersion: snapshot.tlsVersion ?? undefined,
      cipherName: snapshot.cipherName ?? undefined,
      status: snapshot.status as SslStatus,
      error: snapshot.error ?? undefined,
    };
  }

  private async getCertificateForSnapshot(snapshotId: number) {
    const row = await this.db
      .select()
      .from(sslCertificates)
      .where(eq(sslCertificates.snapshotId, snapshotId))
      .get();
    return row ? this.decodeCertificateRow(row) : undefined;
  }

  private decodeCertificateRow(row: {
    fingerprint256: string;
    subject: string | null;
    issuer: string | null;
    validFrom: string | null;
    validTo: string | null;
    serialNumber: string | null;
    san: string | null;
    isSelfSigned: number | null;
    hostnameMatched: number | null;
  }): SslCertificate {
    return {
      fingerprint256: row.fingerprint256,
      subject: row.subject ?? undefined,
      issuer: row.issuer ?? undefined,
      validFrom: row.validFrom ?? undefined,
      validTo: row.validTo ?? undefined,
      serialNumber: row.serialNumber ?? undefined,
      san: decodeStringArray(row.san),
      isSelfSigned: row.isSelfSigned === 1,
      hostnameMatched: row.hostnameMatched === 1,
    };
  }
}

/**
 * Create a D1-backed Repository from a Cloudflare D1 binding (real
 * `env.DB`, a miniflare D1, or any D1-compatible object).
 */
export function createD1Repository(binding: D1BindingLike): Repository {
  return new D1Repository(binding);
}
