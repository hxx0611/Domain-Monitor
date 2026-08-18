"use client";

/**
 * Password recovery form (Phase 9E).
 *
 * Takes the one-time recovery code + a new password. On success the action
 * returns a NEW recovery code (the previous one is consumed); it is shown
 * here exactly once, mirroring the setup wizard. All other sessions are
 * invalidated by the session-secret rotation inside the action.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recoverAdminAction } from "@/lib/auth/actions";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";

const MIN_PASSWORD_LENGTH = 10;

export function RecoverForm({ dict }: { dict: Dictionary }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(lookup(dict, "auth.errors.passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      setError(lookup(dict, "auth.passwordMismatch"));
      return;
    }
    startTransition(async () => {
      const result = await recoverAdminAction({ recoveryCode, password });
      if (!result.ok) {
        setError(lookup(dict, result.error));
        return;
      }
      setNewRecoveryCode(result.recoveryCode ?? null);
    });
  }

  if (newRecoveryCode !== null) {
    return (
      <div className="space-y-4" role="alert">
        <h2 className="text-lg font-semibold">{lookup(dict, "auth.recoveryCodeLabel")}</h2>
        <p className="text-sm text-gray-600">{lookup(dict, "auth.newRecoveryCodeHint")}</p>
        <code className="block break-all rounded-md border border-amber-200 bg-amber-50 px-4 py-3 font-mono text-lg font-semibold tracking-widest text-amber-900">
          {newRecoveryCode}
        </code>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          {lookup(dict, "auth.recoveryCodeContinue")}
        </button>
      </div>
    );
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
        <label htmlFor="recover-code" className="mb-1 block text-sm font-medium text-gray-700">
          {lookup(dict, "auth.recoveryCode")}
        </label>
        <input
          id="recover-code"
          type="text"
          autoComplete="off"
          required
          value={recoveryCode}
          onChange={(event) => setRecoveryCode(event.target.value.trim())}
          className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label htmlFor="recover-password" className="mb-1 block text-sm font-medium text-gray-700">
          {lookup(dict, "auth.password")}
        </label>
        <input
          id="recover-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label htmlFor="recover-confirm" className="mb-1 block text-sm font-medium text-gray-700">
          {lookup(dict, "auth.confirmPassword")}
        </label>
        <input
          id="recover-confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
      >
        {lookup(dict, "auth.recoverSubmit")}
      </button>
    </form>
  );
}
