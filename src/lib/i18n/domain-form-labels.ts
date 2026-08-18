/**
 * Domain add/edit form labels — server-side assembly from the dictionary.
 *
 * Pure function (no server-only, no React): safe for any server component
 * to call. The client form components receive a flat `AddDomainFormLabels`
 * object; this helper builds it from the locale dictionary.
 */
import type { Dictionary } from "./en";
import { lookup } from "./display";

/** Localize a domain-form error code; unknown codes fall back to the raw code. */
export function domainErrorMessage(dict: Dictionary, code: string): string {
  const key = `domains.errors.${code}`;
  const value = lookup(dict, key);
  return value === key ? code : value;
}

/** Build the flat labels object consumed by AddDomainForm / EditDomainForm. */
export function domainFormLabels(dict: Dictionary) {
  const d = dict.domains.domainForm;
  const reminderDaysTemplate = lookup(dict, "domains.domainForm.reminderDays");
  // Flat error-code → localized message map (NO functions: the labels object
  // crosses the Server→Client boundary and Next.js forbids function props).
  const errorMessages: Record<string, string> = {};
  for (const [code, message] of Object.entries(dict.domains.errors)) {
    errorMessages[code] = message;
  }
  return {
    add: dict.actions.addDomain,
    adding: dict.actions.adding,
    cancel: dict.actions.cancel,
    domain: dict.domains.col.domain,
    formHint: dict.domains.formHint,
    edit: d.edit,
    expirationSource: d.expirationSource,
    automatic: d.automatic,
    manual: d.manual,
    registrationDate: d.registrationDate,
    expirationDate: d.expirationDate,
    registrationProvider: d.registrationProvider,
    customProvider: d.customProvider,
    manageUrl: d.manageUrl,
    manageUrlHint: d.manageUrlHint,
    expirationReminders: d.expirationReminders,
    enableReminders: d.enableReminders,
    /** Template with a `{days}` placeholder; client side interpolates. */
    reminderDaysTemplate,
    addReminder: d.addReminder,
    reminderPlaceholder: d.reminderPlaceholder,
    manualHint: d.manualHint,
    save: d.save,
    saving: d.saving,
    errorMessages,
  };
}
