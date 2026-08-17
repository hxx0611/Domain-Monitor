"use client";

/**
 * Generic delete-with-confirmation button (channel / rule).
 *
 * Two-step: click → inline confirm panel (with the cascade warning) →
 * Delete (danger, loading, no double submit) / Cancel. The action is
 * dispatched by kind + id from inside this client component (server
 * actions cannot be passed as function props across the RSC boundary).
 * Errors are controlled machine-code labels — SQLite / network / secret
 * details never reach the UI.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";
import { deleteChannelAction, deleteRuleAction } from "@/lib/notifications/actions";

export function DeleteButton({
  dict,
  kind,
  id,
}: {
  dict: Dictionary;
  /** "channel" | "rule" — picks the action and the confirm body copy. */
  kind: "channel" | "rule";
  id: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const labels = {
    delete: lookup(dict, "notifications.actions.delete"),
    deleting: lookup(dict, "notifications.actions.deleting"),
    cancel: lookup(dict, "notifications.deleteConfirm.cancel"),
    title: lookup(dict, "notifications.deleteConfirm.title"),
    body: lookup(dict, `notifications.deleteConfirm.${kind}Body`),
  };

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result =
        kind === "channel" ? await deleteChannelAction({ id }) : await deleteRuleAction({ id });
      if (!result.ok) {
        setError(lookup(dict, `notifications.errors.${result.error ?? "delete_failed"}`));
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-1">
      {open ? (
        <span
          className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs"
          role="alertdialog"
          aria-label={labels.title}
        >
          <span className="text-red-700">{labels.body}</span>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isPending}
            className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? labels.deleting : labels.delete}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
          >
            {labels.cancel}
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
        >
          {labels.delete}
        </button>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
