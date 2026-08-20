/**
 * Notification message i18n (Phase 11I — v0.8.6).
 *
 * Channel-level notification language for Telegram (and later webhook /
 * email). The language is stored on the channel config (`language`),
 * defaults to `en`, and is independent from the UI locale (cookie-based).
 *
 * Scope decisions:
 * - Only the message TEMPLATE labels and event labels are translated.
 * - Machine state values (`ok` / `down` / `server_error` /
 *   `client_error` / HTTP status codes) are intentionally NOT translated —
 *   they stay as the canonical machine values to avoid ambiguity and to
 *   stay consistent with the UI status display.
 * - Adding a language = adding an entry to the dictionaries below (both
 *   key sets MUST stay identical — enforced by tests).
 */

export type NotificationLanguage = "en" | "zh-CN";

export const DEFAULT_NOTIFICATION_LANGUAGE: NotificationLanguage = "en";

export const NOTIFICATION_LANGUAGES: readonly NotificationLanguage[] = ["en", "zh-CN"];

/** Loose validation used by config parsing and the actions layer. */
export function isNotificationLanguage(value: unknown): value is NotificationLanguage {
  return value === "en" || value === "zh-CN";
}

/** Event labels, keyed by language. Keys mirror EVENT_LABELS in telegram.ts. */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationLanguage, Record<string, string>> = {
  en: {
    dns_record_added: "DNS record added",
    dns_record_removed: "DNS record removed",
    ssl_cert_replaced: "SSL certificate replaced",
    ssl_status_changed: "SSL status changed",
    http_status_changed: "HTTP status changed",
    test_notification: "Test Notification",
  },
  "zh-CN": {
    dns_record_added: "DNS 记录新增",
    dns_record_removed: "DNS 记录移除",
    ssl_cert_replaced: "SSL 证书更换",
    ssl_status_changed: "SSL 状态变化",
    http_status_changed: "HTTP 状态变化",
    test_notification: "测试通知",
  },
};

/** Message template labels, keyed by language. */
export const NOTIFICATION_TEMPLATE_LABELS: Record<
  NotificationLanguage,
  { appTitle: string; event: string; domain: string; status: string; time: string; eventId: string }
> = {
  en: {
    appTitle: "Domain Monitor",
    event: "Event",
    domain: "Domain",
    status: "Status",
    time: "Time",
    eventId: "Event ID",
  },
  "zh-CN": {
    appTitle: "域名监控",
    event: "事件",
    domain: "域名",
    status: "状态",
    time: "时间",
    eventId: "事件 ID",
  },
};
