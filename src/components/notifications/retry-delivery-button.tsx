"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryDeliveryAction } from "@/lib/notifications/actions";

/**
 * Retry a failed delivery. Runs the server action, then refreshes the
 * route so the table re-renders with the new delivery state. Errors are
 * user-safe (the action layer guarantees secret-free messages). Mirrors
 * the CheckDnsButton pattern: useTransition + router.refresh + role="alert".
 */
export function RetryDeliveryButton({ deliveryId }: { deliveryId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRetry() {
    setError(null);

    startTransition(async () => {
      const result = await retryDeliveryAction(deliveryId);

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
        onClick={handleRetry}
        disabled={isPending}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {isPending ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
