"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteDomainAction } from "@/lib/domains/actions";

export interface DeleteDomainButtonLabels {
  delete: string;
  deleting: string;
  /** Template with {hostname} placeholder, interpolated client-side. */
  confirmTemplate: string;
}

export function DeleteDomainButton({
  id,
  hostname,
  labels,
}: {
  id: number;
  hostname: string;
  labels: DeleteDomainButtonLabels;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    const message = labels.confirmTemplate.replace("{hostname}", hostname);
    if (!window.confirm(message)) {
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
      {isPending ? labels.deleting : labels.delete}
    </button>
  );
}
