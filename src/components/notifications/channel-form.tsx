"use client";

/**
 * Notification channel create/edit form + add/edit/toggle triggers.
 *
 * Client component; follows the RetryDeliveryButton pattern
 * (useTransition + router.refresh + role="alert"). Secret policy: the
 * form only ever collects secretRef / apiKeyRef NAMES (env var names).
 * There is deliberately NO password-style input — the real secret value
 * lives in the supervisor environment and is never read by the UI.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";
import {
  createChannelAction,
  setChannelEnabledAction,
  updateChannelAction,
  type ChannelView,
} from "@/lib/notifications/actions";

const CHANNEL_TYPES = ["email", "webhook", "telegram"] as const;
type ChannelTypeValue = (typeof CHANNEL_TYPES)[number];

/** Pull a display field value out of the non-sensitive config fields. */
function fieldValue(channel: ChannelView | undefined, label: string): string {
  if (!channel) {
    return "";
  }
  return channel.configFields.find((f) => f.label === label)?.value ?? "";
}

export function ChannelForm({
  mode,
  channel,
  dict,
  onDone,
}: {
  mode: "create" | "edit";
  channel?: ChannelView;
  dict: Dictionary;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<ChannelTypeValue>(channel?.type ?? "telegram");
  const [name, setName] = useState(channel?.name ?? "");
  const [chatId, setChatId] = useState(fieldValue(channel, "Chat ID"));
  const [secretRef, setSecretRef] = useState(fieldValue(channel, "Secret ref"));
  const [url, setUrl] = useState(fieldValue(channel, "URL"));
  const [to, setTo] = useState(fieldValue(channel, "To"));
  const [from, setFrom] = useState(fieldValue(channel, "From"));
  const [endpoint, setEndpoint] = useState(fieldValue(channel, "Endpoint"));
  const [apiKeyRef, setApiKeyRef] = useState(fieldValue(channel, "API key ref"));

  function buildConfig(): string {
    if (type === "telegram") {
      return JSON.stringify({ chatId, secretRef });
    }
    if (type === "webhook") {
      return JSON.stringify(secretRef.trim() === "" ? { url } : { url, secretRef });
    }
    return JSON.stringify({ to, from, endpoint, apiKeyRef });
  }

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result =
        mode === "create"
          ? await createChannelAction({ type, name, config: buildConfig() })
          : await updateChannelAction({ id: channel!.id, name, config: buildConfig() });

      if (!result.ok) {
        setError(lookup(dict, `notifications.errors.${result.error}`));
        return;
      }
      router.refresh();
      onDone?.();
    });
  }

  const labels = {
    name: lookup(dict, "notifications.channelForm.name"),
    type: lookup(dict, "notifications.channelForm.type"),
    chatId: lookup(dict, "notifications.channelForm.chatId"),
    chatIdHint: lookup(dict, "notifications.channelForm.chatIdHint"),
    secretRef: lookup(dict, "notifications.channelForm.secretRef"),
    secretRefHint: lookup(dict, "notifications.channelForm.secretRefHint"),
    url: lookup(dict, "notifications.channelForm.url"),
    to: lookup(dict, "notifications.channelForm.to"),
    from: lookup(dict, "notifications.channelForm.from"),
    endpoint: lookup(dict, "notifications.channelForm.endpoint"),
    apiKeyRef: lookup(dict, "notifications.channelForm.apiKeyRef"),
    save: lookup(dict, "notifications.channelForm.save"),
    cancel: lookup(dict, "notifications.channelForm.cancel"),
    saving: lookup(dict, "notifications.actions.saving"),
  };

  const inputClass =
    "w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:bg-gray-100";

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
          <span className="mb-1 block font-medium text-gray-700">{labels.type}</span>
          <select
            className={inputClass}
            value={type}
            onChange={(event) => setType(event.target.value as ChannelTypeValue)}
            disabled={mode === "edit" || isPending}
            aria-label={labels.type}
          >
            {CHANNEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {lookup(dict, `notifications.channel${capitalize(t)}`)}
              </option>
            ))}
          </select>
        </label>

        {type === "telegram" && (
          <>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">{labels.chatId}</span>
              <input
                className={inputClass}
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
                required
                disabled={isPending}
                aria-label={labels.chatId}
              />
              <span className="mt-1 block text-xs text-gray-500">{labels.chatIdHint}</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">{labels.secretRef}</span>
              <input
                className={inputClass}
                value={secretRef}
                onChange={(event) => setSecretRef(event.target.value)}
                required
                disabled={isPending}
                aria-label={labels.secretRef}
              />
              <span className="mt-1 block text-xs text-gray-500">{labels.secretRefHint}</span>
            </label>
          </>
        )}

        {type === "webhook" && (
          <>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-gray-700">{labels.url}</span>
              <input
                className={inputClass}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
                type="url"
                disabled={isPending}
                aria-label={labels.url}
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-gray-700">{labels.secretRef}</span>
              <input
                className={inputClass}
                value={secretRef}
                onChange={(event) => setSecretRef(event.target.value)}
                disabled={isPending}
                aria-label={labels.secretRef}
              />
              <span className="mt-1 block text-xs text-gray-500">{labels.secretRefHint}</span>
            </label>
          </>
        )}

        {type === "email" && (
          <>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">{labels.to}</span>
              <input
                className={inputClass}
                value={to}
                onChange={(event) => setTo(event.target.value)}
                required
                type="email"
                disabled={isPending}
                aria-label={labels.to}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">{labels.from}</span>
              <input
                className={inputClass}
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
                type="email"
                disabled={isPending}
                aria-label={labels.from}
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-gray-700">{labels.endpoint}</span>
              <input
                className={inputClass}
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                required
                type="url"
                disabled={isPending}
                aria-label={labels.endpoint}
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-gray-700">{labels.apiKeyRef}</span>
              <input
                className={inputClass}
                value={apiKeyRef}
                onChange={(event) => setApiKeyRef(event.target.value)}
                required
                disabled={isPending}
                aria-label={labels.apiKeyRef}
              />
              <span className="mt-1 block text-xs text-gray-500">{labels.secretRefHint}</span>
            </label>
          </>
        )}
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Add Channel" trigger — toggles a create form in place. */
export function AddChannelButton({ dict }: { dict: Dictionary }) {
  const [open, setOpen] = useState(false);
  const label = lookup(dict, "notifications.addChannel");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        {label}
      </button>
    );
  }
  return <ChannelForm mode="create" dict={dict} onDone={() => setOpen(false)} />;
}

/** "Edit" trigger per row — toggles an edit form in place. */
export function EditChannelButton({ channel, dict }: { channel: ChannelView; dict: Dictionary }) {
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
  return <ChannelForm mode="edit" channel={channel} dict={dict} onDone={() => setOpen(false)} />;
}

/** Enable/Disable toggle per row. */
export function ChannelToggleButton({ channel, dict }: { channel: ChannelView; dict: Dictionary }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const enabled = channel.enabled;
  const label = lookup(dict, `notifications.actions.${enabled ? "disable" : "enable"}`);

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = await setChannelEnabledAction({ id: channel.id, enabled: !enabled });
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
