"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateDomainAction } from "@/lib/domains/actions";
import { REGISTRATION_PROVIDERS } from "@/lib/domains/providers";
import { REMINDER_PRESETS, reminderDaysLabel, type AddDomainFormLabels } from "./add-domain-form";

export interface EditDomainView {
  id: number;
  hostname: string;
  expirationSource: "rdap" | "manual";
  registrationDate: string | null;
  expirationDate: string | null;
  registrationProvider: string | null;
  registrationProviderUrl: string | null;
}

/** "Edit" trigger — toggles the edit form in place (like AddRuleButton). */
export function EditDomainButton({
  domain,
  reminders,
  labels,
}: {
  domain: EditDomainView;
  reminders: number[];
  labels: AddDomainFormLabels;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        {labels.edit}
      </button>
    );
  }
  return (
    <EditDomainForm
      domain={domain}
      reminders={reminders}
      labels={labels}
      onDone={() => setOpen(false)}
    />
  );
}

export function EditDomainForm({
  domain,
  reminders,
  labels,
  onDone,
}: {
  domain: EditDomainView;
  reminders: number[];
  labels: AddDomainFormLabels;
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const presetIds = new Set(REGISTRATION_PROVIDERS.map((preset) => preset.id));
  const initialProvider = domain.registrationProvider ?? "";
  const initialProviderIsPreset = presetIds.has(initialProvider);

  const [source, setSource] = useState<"rdap" | "manual">(domain.expirationSource);
  const [registrationDate, setRegistrationDate] = useState(
    domain.registrationDate?.slice(0, 10) ?? "",
  );
  const [expirationDate, setExpirationDate] = useState(domain.expirationDate?.slice(0, 10) ?? "");
  const [provider, setProvider] = useState<string>(
    initialProviderIsPreset ? initialProvider : initialProvider ? "custom" : "",
  );
  const [providerName, setProviderName] = useState(
    initialProvider && !initialProviderIsPreset ? initialProvider : "",
  );
  const [providerUrl, setProviderUrl] = useState(domain.registrationProviderUrl ?? "");
  const [remindersEnabled, setRemindersEnabled] = useState(reminders.length > 0);
  const [presetDays, setPresetDays] = useState<ReadonlySet<number>>(
    () =>
      new Set(reminders.filter((days) => (REMINDER_PRESETS as readonly number[]).includes(days))),
  );
  const [customDays, setCustomDays] = useState<number[]>(
    reminders.filter((days) => !(REMINDER_PRESETS as readonly number[]).includes(days)),
  );
  const [customInput, setCustomInput] = useState("");

  function togglePreset(days: number, checked: boolean) {
    const next = new Set(presetDays);
    if (checked) {
      next.add(days);
    } else {
      next.delete(days);
    }
    setPresetDays(next);
  }

  function addCustomReminder() {
    const value = Number(customInput);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      return;
    }
    if (!presetDays.has(value) && !customDays.includes(value)) {
      setCustomDays([...customDays, value].sort((a, b) => b - a));
    }
    setCustomInput("");
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError(null);

    const remindersList = remindersEnabled ? [...presetDays, ...customDays] : [];
    const providerValue = provider === "custom" ? providerName.trim() || null : provider || null;
    const url = providerUrl.trim() || null;

    startTransition(async () => {
      const result = await updateDomainAction(domain.id, {
        expirationSource: source,
        registrationDate: source === "manual" ? registrationDate : null,
        expirationDate: source === "manual" ? expirationDate : null,
        registrationProvider: providerValue,
        registrationProviderUrl: url,
        reminders: remindersList,
      });

      if (!result.ok) {
        setError(labels.errorMessages[result.error] ?? result.error);
        return;
      }

      router.refresh();
      onDone?.();
    });
  }

  const inputClass =
    "w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60";

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-xl space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4"
    >
      <div>
        <span className="text-sm font-medium text-gray-900">{domain.hostname}</span>
      </div>

      <fieldset>
        <legend className="mb-1.5 block text-sm font-medium text-gray-700">
          {labels.expirationSource}
        </legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-900">
            <input
              type="radio"
              name="expiration-source"
              checked={source === "rdap"}
              onChange={() => setSource("rdap")}
              disabled={isPending}
              className="h-4 w-4 border-gray-300"
            />
            {labels.automatic}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-900">
            <input
              type="radio"
              name="expiration-source"
              checked={source === "manual"}
              onChange={() => setSource("manual")}
              disabled={isPending}
              className="h-4 w-4 border-gray-300"
            />
            {labels.manual}
          </label>
        </div>
      </fieldset>

      {source === "manual" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">
                {labels.registrationDate}
              </span>
              <input
                type="date"
                value={registrationDate}
                onChange={(event) => setRegistrationDate(event.target.value)}
                disabled={isPending}
                className={inputClass}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">{labels.expirationDate}</span>
              <input
                type="date"
                value={expirationDate}
                onChange={(event) => setExpirationDate(event.target.value)}
                disabled={isPending}
                className={inputClass}
              />
            </label>
          </div>
          <p className="text-xs text-gray-500">{labels.manualHint}</p>
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">
            {labels.registrationProvider}
          </span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            disabled={isPending}
            className={inputClass}
          >
            <option value="">—</option>
            {REGISTRATION_PROVIDERS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
            <option value="custom">{labels.customProvider}</option>
          </select>
        </label>
        {provider === "custom" && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">
              {labels.registrationProvider}
            </span>
            <input
              type="text"
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              placeholder="My registrar"
              disabled={isPending}
              className={inputClass}
            />
          </label>
        )}
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">{labels.manageUrl}</span>
        <input
          type="text"
          value={providerUrl}
          onChange={(event) => setProviderUrl(event.target.value)}
          placeholder="https://…"
          disabled={isPending}
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-gray-500">{labels.manageUrlHint}</span>
      </label>

      <fieldset>
        <legend className="mb-1.5 block text-sm font-medium text-gray-700">
          {labels.expirationReminders}
        </legend>
        <label className="mb-2 flex items-center gap-2 text-sm text-gray-900">
          <input
            type="checkbox"
            checked={remindersEnabled}
            onChange={(event) => setRemindersEnabled(event.target.checked)}
            disabled={isPending}
            className="h-4 w-4 rounded border-gray-300"
          />
          {labels.enableReminders}
        </label>
        {remindersEnabled && (
          <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3">
            <div className="flex flex-wrap gap-3">
              {REMINDER_PRESETS.map((days) => (
                <label key={days} className="flex items-center gap-1.5 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    checked={presetDays.has(days)}
                    onChange={(event) => togglePreset(days, event.target.checked)}
                    disabled={isPending}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  {reminderDaysLabel(labels, days)}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="number"
                min={1}
                max={3650}
                value={customInput}
                onChange={(event) => setCustomInput(event.target.value)}
                placeholder={labels.reminderPlaceholder}
                disabled={isPending}
                className="w-28 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900"
              />
              <button
                type="button"
                onClick={addCustomReminder}
                disabled={isPending}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-100"
              >
                {labels.addReminder}
              </button>
            </div>
            {customDays.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {customDays.map((days) => (
                  <span
                    key={days}
                    className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800"
                  >
                    {reminderDaysLabel(labels, days)}
                    <button
                      type="button"
                      onClick={() => setCustomDays(customDays.filter((d) => d !== days))}
                      disabled={isPending}
                      aria-label={`Remove ${reminderDaysLabel(labels, days)}`}
                      className="text-blue-500 hover:text-blue-700"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </fieldset>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : (
        <p className="mt-2 text-xs text-gray-500">{labels.formHint}</p>
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
