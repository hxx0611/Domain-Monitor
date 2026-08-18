"use client";

/**
 * Notification rule create/edit form + add/edit/toggle triggers.
 *
 * Client component; same interaction pattern as channel-form.tsx. The
 * event-type list is NOT duplicated here — labels come from the shared
 * display mapping (eventTypeLabel) over the existing i18n dictionaries,
 * and the allowed values mirror the action-layer whitelist (RDAP is not
 * an option).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup, eventTypeLabel } from "@/lib/i18n/display";
import {
  createRuleAction,
  setRuleEnabledAction,
  updateRuleAction,
  type ChannelView,
  type RuleView,
} from "@/lib/notifications/actions";

const SOURCES = ["dns", "ssl", "http", "expiration"] as const;
const EVENT_TYPES = [
  "dns_record_added",
  "dns_record_removed",
  "ssl_cert_replaced",
  "ssl_status_changed",
  "http_status_changed",
  "expiration_reminder",
] as const;

export interface RuleFormOption {
  id: number;
  label: string;
}

export function RuleForm({
  mode,
  rule,
  channels,
  domains,
  dict,
  onDone,
}: {
  mode: "create" | "edit";
  rule?: RuleView;
  channels: ChannelView[];
  domains: RuleFormOption[];
  dict: Dictionary;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(rule?.name ?? "");
  const [channelId, setChannelId] = useState<number>(rule?.channelId ?? channels[0]?.id ?? 0);
  const [source, setSource] = useState<string>(rule?.source ?? "ALL");
  const [eventType, setEventType] = useState<string>(rule?.eventType ?? "ALL");
  const [domainId, setDomainId] = useState<string>(
    rule?.domainId == null ? "ALL" : String(rule.domainId),
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  const labels = {
    name: lookup(dict, "notifications.ruleForm.name"),
    channel: lookup(dict, "notifications.ruleForm.channel"),
    source: lookup(dict, "notifications.ruleForm.source"),
    eventType: lookup(dict, "notifications.ruleForm.eventType"),
    domain: lookup(dict, "notifications.ruleForm.domain"),
    enabled: lookup(dict, "notifications.ruleForm.enabled"),
    all: lookup(dict, "notifications.ruleForm.all"),
    save: lookup(dict, "notifications.ruleForm.save"),
    cancel: lookup(dict, "notifications.ruleForm.cancel"),
    saving: lookup(dict, "notifications.actions.saving"),
  };

  const inputClass =
    "w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:bg-gray-100";

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const input = {
        name,
        channelId,
        source: source === "ALL" ? null : source,
        eventType: eventType === "ALL" ? null : eventType,
        domainId: domainId === "ALL" ? null : Number(domainId),
        enabled,
      };
      const result =
        mode === "create"
          ? await createRuleAction(input)
          : await updateRuleAction({ id: rule!.id, ...input });

      if (!result.ok) {
        setError(lookup(dict, `notifications.errors.${result.error}`));
        return;
      }
      router.refresh();
      onDone?.();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">{labels.name}</span>
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={isPending}
            aria-label={labels.name}
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">{labels.channel}</span>
          <select
            className={inputClass}
            value={channelId}
            onChange={(event) => setChannelId(Number(event.target.value))}
            disabled={isPending}
            aria-label={labels.channel}
          >
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">{labels.source}</span>
          <select
            className={inputClass}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={isPending}
            aria-label={labels.source}
          >
            <option value="ALL">{labels.all}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {lookup(dict, `source.${s}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">{labels.eventType}</span>
          <select
            className={inputClass}
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            disabled={isPending}
            aria-label={labels.eventType}
          >
            <option value="ALL">{labels.all}</option>
            {EVENT_TYPES.map((eventTypeValue) => (
              <option key={eventTypeValue} value={eventTypeValue}>
                {eventTypeLabel(eventTypeValue, dict)}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">{labels.domain}</span>
          <select
            className={inputClass}
            value={domainId}
            onChange={(event) => setDomainId(event.target.value)}
            disabled={isPending}
            aria-label={labels.domain}
          >
            <option value="ALL">{labels.all}</option>
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-end gap-2 pb-1.5 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={isPending}
            className="h-4 w-4 rounded border-gray-300"
            aria-label={labels.enabled}
          />
          <span className="font-medium text-gray-700">{labels.enabled}</span>
        </label>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? labels.saving : labels.save}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={isPending}
          className="rounded-md border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          {labels.cancel}
        </button>
      </div>
    </form>
  );
}

/** "Add Rule" trigger — toggles a create form in place. */
export function AddRuleButton({
  channels,
  domains,
  dict,
}: {
  channels: ChannelView[];
  domains: RuleFormOption[];
  dict: Dictionary;
}) {
  const [open, setOpen] = useState(false);
  const label = lookup(dict, "notifications.addRule");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={channels.length === 0}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        title={channels.length === 0 ? "Add a channel first." : undefined}
      >
        {label}
      </button>
    );
  }
  return (
    <RuleForm
      mode="create"
      channels={channels}
      domains={domains}
      dict={dict}
      onDone={() => setOpen(false)}
    />
  );
}

/** "Edit" trigger per row — toggles an edit form in place. */
export function EditRuleButton({
  rule,
  channels,
  domains,
  dict,
}: {
  rule: RuleView;
  channels: ChannelView[];
  domains: RuleFormOption[];
  dict: Dictionary;
}) {
  const [open, setOpen] = useState(false);
  const label = lookup(dict, "notifications.actions.edit");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
      >
        {label}
      </button>
    );
  }
  return (
    <RuleForm
      mode="edit"
      rule={rule}
      channels={channels}
      domains={domains}
      dict={dict}
      onDone={() => setOpen(false)}
    />
  );
}

/** Enable/Disable toggle per row. */
export function RuleToggleButton({ rule, dict }: { rule: RuleView; dict: Dictionary }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const enabled = rule.enabled;
  const label = lookup(dict, `notifications.actions.${enabled ? "disable" : "enable"}`);

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = await setRuleEnabledAction({ id: rule.id, enabled: !enabled });
      if (!result.ok) {
        setError(lookup(dict, `notifications.errors.${result.error}`));
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
      >
        {isPending ? "…" : label}
      </button>
      {error && (
        <span role="alert" className="ml-1 text-xs text-red-600">
          {error}
        </span>
      )}
    </>
  );
}
