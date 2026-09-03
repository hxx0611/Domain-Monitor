/**
 * SQLite runtime adapter (Phase 14C-1).
 *
 * Implements the Repository contract on the Node self-hosted runtime:
 * better-sqlite3 + drizzle-orm/better-sqlite3, SYNCHRONOUS driver behind an
 * ASYNC facade.
 *
 * The adapter is a thin async wrapper around the existing feature-repository
 * functions (src/lib/<feature>/repository.ts), which remain the SQLite
 * implementation layer. Node behavior is preserved exactly: same driver,
 * same schema, same journal mode, same transaction semantics.
 *
 * Business-layer code must never import this module directly — use the
 * `Repository` contract / factory from `@/db/repository`.
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { isNotNull } from "drizzle-orm";
import type { Schema, Domain, NotificationChannel, NotificationDelivery } from "@/db/schema";
import { domains } from "@/db/schema";
import type { Repository } from "../repository";

import * as domainsRepo from "@/lib/domains/repository";
import * as dnsRepo from "@/lib/dns/repository";
import * as httpRepo from "@/lib/http/repository";
import * as sslRepo from "@/lib/ssl/repository";
import * as notificationsRepo from "@/lib/notifications/repository";
import { insertEventsAndGenerateDeliveries } from "@/lib/notifications/event-deliveries";
import * as secretsRepo from "@/lib/notifications/secrets";
import * as adminRepo from "@/lib/auth/admin-db";

/** SQLite implementation of the Repository contract. */
export class SQLiteRepository implements Repository {
  private readonly db: BetterSQLite3Database<Schema>;

  constructor(db: BetterSQLite3Database<Schema>) {
    this.db = db;
  }

  // ── Domains ──────────────────────────────────────────────────────────────
  async getDomains() {
    return domainsRepo.getDomains(this.db);
  }
  async getDomainById(id: number) {
    return domainsRepo.getDomainById(id, this.db);
  }
  async getDomainByHostname(hostname: string) {
    return domainsRepo.getDomainByHostname(hostname, this.db);
  }
  async createDomain(hostname: string, fields?: Parameters<Repository["createDomain"]>[1]) {
    return domainsRepo.createDomain(hostname, fields, this.db);
  }
  async updateDomain(id: number, fields: Parameters<Repository["updateDomain"]>[1]) {
    return domainsRepo.updateDomain(id, fields, this.db);
  }
  async deleteDomain(id: number) {
    return domainsRepo.deleteDomain(id, this.db);
  }
  async updateDomainRdap(
    id: number,
    data: Parameters<Repository["updateDomainRdap"]>[1],
    ownership: Parameters<Repository["updateDomainRdap"]>[2],
  ) {
    return domainsRepo.updateDomainRdap(id, data, ownership, this.db);
  }

  // ── Expiration reminders ─────────────────────────────────────────────────
  async getExpirationReminders(domainId: number) {
    return domainsRepo.getExpirationReminders(domainId, this.db);
  }
  async setExpirationReminders(domainId: number, days: number[]) {
    return domainsRepo.setExpirationReminders(domainId, days, this.db);
  }
  async getAllExpirationReminders() {
    return domainsRepo.getAllExpirationReminders(this.db);
  }
  async getDomainsWithExpiration(): Promise<Domain[]> {
    return this.db.select().from(domains).where(isNotNull(domains.expirationDate)).all();
  }

  // ── DNS ──────────────────────────────────────────────────────────────────
  async createDnsSnapshot(
    domainId: number,
    records: Parameters<Repository["createDnsSnapshot"]>[1],
    events?: Parameters<Repository["createDnsSnapshot"]>[2],
  ) {
    return dnsRepo.createDnsSnapshot(domainId, records, this.db, events ?? []);
  }
  async getLatestDnsSnapshot(domainId: number) {
    return dnsRepo.getLatestDnsSnapshot(domainId, this.db);
  }
  async getDnsSnapshots(domainId: number, limit: number) {
    return dnsRepo.getDnsSnapshots(domainId, limit, this.db);
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  async createHttpSnapshot(
    data: Parameters<Repository["createHttpSnapshot"]>[0],
    events?: Parameters<Repository["createHttpSnapshot"]>[1],
  ) {
    return httpRepo.createHttpSnapshot(data, this.db, events ?? []);
  }
  async getLatestHttpSnapshot(domainId: number) {
    return httpRepo.getLatestHttpSnapshot(domainId, this.db);
  }
  async getHttpHistory(domainId: number, limit: number) {
    return httpRepo.getHttpHistory(domainId, limit, this.db);
  }

  // ── SSL ──────────────────────────────────────────────────────────────────
  async createSslSnapshot(
    data: Parameters<Repository["createSslSnapshot"]>[0],
    events?: Parameters<Repository["createSslSnapshot"]>[1],
  ) {
    return sslRepo.createSslSnapshot(data, this.db, events ?? []);
  }
  async getLatestSslSnapshot(domainId: number) {
    return sslRepo.getLatestSslSnapshot(domainId, this.db);
  }
  async getSslHistory(domainId: number, limit: number) {
    return sslRepo.getSslHistory(domainId, limit, this.db);
  }

  // ── Notification events ──────────────────────────────────────────────────
  async insertNotificationEvents(events: Parameters<Repository["insertNotificationEvents"]>[0]) {
    return notificationsRepo.insertNotificationEvents(this.db, events);
  }
  async insertEventsAndGenerateDeliveries(
    events: Parameters<Repository["insertEventsAndGenerateDeliveries"]>[0],
  ) {
    return this.db.transaction((tx) => insertEventsAndGenerateDeliveries(tx, events));
  }

  // ── Notification channels ────────────────────────────────────────────────
  async getChannels(): Promise<NotificationChannel[]> {
    return notificationsRepo.getChannels(this.db);
  }
  async getChannel(channelId: number) {
    return notificationsRepo.getChannel(channelId, this.db);
  }
  async createChannel(type: string, name: string, config: string) {
    return notificationsRepo.createChannel(type, name, config, this.db);
  }
  async updateChannel(channelId: number, fields: Parameters<Repository["updateChannel"]>[1]) {
    return notificationsRepo.updateChannel(channelId, fields, this.db);
  }
  async setChannelEnabled(channelId: number, enabled: boolean) {
    return notificationsRepo.setChannelEnabled(channelId, enabled, this.db);
  }
  async deleteChannel(channelId: number) {
    return notificationsRepo.deleteChannel(channelId, this.db);
  }

  // ── Notification rules ───────────────────────────────────────────────────
  async getEnabledRules() {
    return notificationsRepo.getEnabledRules(this.db);
  }
  async getRules() {
    return notificationsRepo.getRules(this.db);
  }
  async createRule(fields: Parameters<Repository["createRule"]>[0]) {
    return notificationsRepo.createRule(fields, this.db);
  }
  async updateRule(ruleId: number, fields: Parameters<Repository["updateRule"]>[1]) {
    return notificationsRepo.updateRule(ruleId, fields, this.db);
  }
  async setRuleEnabled(ruleId: number, enabled: boolean) {
    return notificationsRepo.setRuleEnabled(ruleId, enabled, this.db);
  }
  async deleteRule(ruleId: number) {
    return notificationsRepo.deleteRule(ruleId, this.db);
  }

  // ── Notification deliveries (state machine) ─────────────────────────────
  async createDelivery(eventId: number, channelId: number) {
    return notificationsRepo.createDelivery(eventId, channelId, this.db);
  }
  async getDelivery(deliveryId: number): Promise<NotificationDelivery | undefined> {
    return notificationsRepo.getDelivery(deliveryId, this.db);
  }
  async getEvent(eventId: number) {
    return notificationsRepo.getEvent(eventId, this.db);
  }
  async getEventDeliveries(eventId: number) {
    return notificationsRepo.getEventDeliveries(eventId, this.db);
  }
  async getPendingDeliveries(limit: number) {
    return notificationsRepo.getPendingDeliveries(limit, this.db);
  }
  async getDeliveriesWithDetails() {
    return notificationsRepo.getDeliveriesWithDetails(this.db);
  }
  async claimPendingDelivery(deliveryId: number, now: Date = new Date()) {
    return notificationsRepo.claimPendingDelivery(deliveryId, this.db, now);
  }
  async markDeliverySent(deliveryId: number, now: Date = new Date()) {
    return notificationsRepo.markDeliverySent(deliveryId, this.db, now);
  }
  async markDeliveryFailed(deliveryId: number, error: string) {
    return notificationsRepo.markDeliveryFailed(deliveryId, error, this.db);
  }
  async retryDelivery(deliveryId: number) {
    return notificationsRepo.retryDelivery(deliveryId, this.db);
  }
  async recoverStaleSending(staleAfterMs: number = 300_000, now: Date = new Date()) {
    return notificationsRepo.recoverStaleSending(this.db, staleAfterMs, now);
  }

  // ── Notification secrets ─────────────────────────────────────────────────
  async setChannelSecret(channelId: number, key: string, value: string | null) {
    return secretsRepo.setChannelSecret(channelId, key, value, this.db);
  }
  async getChannelSecret(channelId: number, key: string) {
    return secretsRepo.getChannelSecret(channelId, key, this.db);
  }
  async hasChannelSecret(channelId: number, key: string) {
    return secretsRepo.hasChannelSecret(channelId, key, this.db);
  }

  // ── Admin settings ───────────────────────────────────────────────────────
  async getAdminRow() {
    return adminRepo.getAdminRow(this.db);
  }
  async insertAdminRow(values: Parameters<Repository["insertAdminRow"]>[0]) {
    return adminRepo.insertAdminRow(this.db, values);
  }
  async updateAdminRow(id: number, values: Parameters<Repository["updateAdminRow"]>[1]) {
    return adminRepo.updateAdminRow(this.db, id, values);
  }
  async isAdminConfigured() {
    return adminRepo.isAdminConfigured(this.db);
  }
  async getSessionSecret() {
    return adminRepo.getSessionSecret(this.db);
  }
  async getEncryptionKey() {
    return adminRepo.getEncryptionKey(this.db);
  }
}

/**
 * Create a SQLite-backed Repository from an existing drizzle sqlite
 * database instance (the app singleton, or a test instance via
 * `createTestDb()`).
 */
export function createSQLiteRepository(db: BetterSQLite3Database<Schema>): Repository {
  return new SQLiteRepository(db);
}
