"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { checkHttpAction } from "@/lib/http/actions";
import { errorMessage } from "@/lib/i18n/display";
import type { Dictionary } from "@/lib/i18n/en";
import type { CheckButtonLabels } from "./check-dns-button";

/**
 * Manual HTTP health check trigger. Runs the server action, then refreshes
 * the route so the server re-renders the HTTP section with the new
 * snapshot. The button is disabled while a check is running (client-side
 * guard on top of the service's in-flight guard).
 *
 * Errors render through the locale-aware error code mapping; the raw
 * action message is only a fallback for unknown codes.
 */
export function CheckHttpButton({
  domainId,
  labels,
  dict,
}: {
  domainId: number;
  labels: CheckButtonLabels;
  dict: Dictionary;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  function handleCheck() {
    setError(null);

    startTransition(async () => {
      const result = await checkHttpAction(domainId);

      if (!result.ok) {
        setError({ message: result.error, code: result.errorCode });
        return;
      }

      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error.code ? (errorMessage(error.code, dict) ?? error.message) : error.message}
        </p>
      ) : null}
      <button
        type="button"
        onClick={handleCheck}
        disabled={isPending}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {isPending ? labels.checking : labels.check}
      </button>
    </div>
  );
}
