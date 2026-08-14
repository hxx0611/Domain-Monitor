/**
 * Notification rule matching.
 *
 * Pure functions that decide whether a rule applies to an event. Rules
 * filter on source / event type / domain; a null filter matches
 * everything. A disabled rule never matches.
 *
 * No network, no database.
 */

import type { NotificationEvent, NotificationRuleFilter } from "./types";

/** True when the rule matches the event. */
export function matchesRule(rule: NotificationRuleFilter, event: NotificationEvent): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.source !== null && rule.source !== event.source) {
    return false;
  }
  if (rule.eventType !== null && rule.eventType !== event.eventType) {
    return false;
  }
  if (rule.domainId !== null && rule.domainId !== event.domainId) {
    return false;
  }
  return true;
}

/** All rules that match the event (empty array when none). */
export function matchRules(
  rules: NotificationRuleFilter[],
  event: NotificationEvent,
): NotificationRuleFilter[] {
  return rules.filter((rule) => matchesRule(rule, event));
}
