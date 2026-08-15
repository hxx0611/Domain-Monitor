"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { checkDnsAction } from "@/lib/dns/actions";

export interface CheckButtonLabels {
  check: string;
  checking: string;
}

/**
 * Manual DNS check trigger. Runs the server action, then refreshes the
 * route so the server re-renders the DNS sections with the new snapshot.
 * The button is disabled while a check is running (client-side guard on
 * top of the service's in-flight guard).
 */
export function CheckDnsButton({
  domainId,
  labels,
}: {
  domainId: number;
  labels: CheckButtonLabels;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleCheck() {
    setError(null);

    startTransition(async () => {
      const result = await checkDnsAction(domainId);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
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
