"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { logoutAdminAction } from "@/lib/auth/actions";

/**
 * Logout button for protected page nav bars. Clears the admin session
 * cookie and returns to the login page.
 */
export function LogoutButton({ label }: { label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleLogout() {
    startTransition(async () => {
      await logoutAdminAction();
      router.push("/login");
    });
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={isPending}
      className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:opacity-60"
    >
      {label}
    </button>
  );
}
