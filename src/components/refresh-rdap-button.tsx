"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshRdapAction } from "@/lib/domains/actions";

export interface RefreshRdapButtonLabels {
  refresh: string;
  refreshing: string;
}

export function RefreshRdapButton({ id, labels }: { id: number; labels: RefreshRdapButtonLabels }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRefresh() {
    setError(null);

    startTransition(async () => {
      const result = await refreshRdapAction(id);

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
        onClick={handleRefresh}
        disabled={isPending}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {isPending ? labels.refreshing : labels.refresh}
      </button>
    </div>
  );
}
