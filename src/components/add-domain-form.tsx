"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDomainAction } from "@/lib/domains/actions";

export function AddDomainForm() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError(null);

    startTransition(async () => {
      const result = await createDomainAction(hostname);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setHostname("");
      setIsOpen(false);
      router.refresh();
    });
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      >
        Add Domain
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md">
      <label htmlFor="domain-input" className="mb-1.5 block text-sm font-medium text-gray-700">
        Domain
      </label>
      <div className="flex gap-2">
        <input
          id="domain-input"
          type="text"
          value={hostname}
          onChange={(event) => setHostname(event.target.value)}
          placeholder="example.com"
          autoFocus
          disabled={isPending}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={isPending}
          className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {isPending ? "Adding…" : "Add Domain"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : (
        <p className="mt-2 text-xs text-gray-500">
          Accepts URLs and bare hostnames (e.g. https://example.com/path → example.com).
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="mt-3 text-sm text-gray-500 hover:text-gray-700 hover:underline"
      >
        Cancel
      </button>
    </form>
  );
}
