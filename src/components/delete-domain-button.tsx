"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteDomainAction } from "@/lib/domains/actions";

export function DeleteDomainButton({ id, hostname }: { id: number; hostname: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    if (!window.confirm(`Delete ${hostname}?`)) {
      return;
    }

    startTransition(async () => {
      const result = await deleteDomainAction(id);

      if (!result.ok) {
        window.alert(result.error);
        return;
      }

      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isPending}
      className="text-sm font-medium text-red-600 hover:text-red-800 hover:underline disabled:opacity-60"
    >
      {isPending ? "Deleting…" : "Delete"}
    </button>
  );
}
