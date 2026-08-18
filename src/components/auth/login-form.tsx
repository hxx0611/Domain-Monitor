"use client";

/**
 * Login form (Phase 9E).
 *
 * Password login. Failures render the uniform "invalid credentials"
 * message — the action never distinguishes "not configured" from "wrong
 * password", so the UI cannot leak whether the account exists.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginAdminAction } from "@/lib/auth/actions";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";

export function LoginForm({ dict }: { dict: Dictionary }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await loginAdminAction({ password });
      if (!result.ok) {
        setError(lookup(dict, result.error));
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
      <div>
        <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-gray-700">
          {lookup(dict, "auth.password")}
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
      >
        {lookup(dict, "auth.loginSubmit")}
      </button>
      <p className="text-center text-sm">
        <Link href="/recover" className="text-gray-500 hover:text-gray-700 hover:underline">
          {lookup(dict, "auth.forgotPassword")}
        </Link>
      </p>
    </form>
  );
}
