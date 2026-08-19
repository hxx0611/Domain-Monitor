"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendTestNotificationAction } from "@/lib/notifications/actions";

export interface TestNotificationButtonLabels {
  send: string;
  sending: string;
  success: string;
}

/**
 * Admin-triggered single test notification (Phase 11G-A).
 *
 * Runs `sendTestNotificationAction(channelId)` — the server action enforces
 * requireAdmin + channel validation + exactly-one-send limits. The client
 * never touches tokens, ciphertext or the Telegram API; it only renders
 * loading / success / controlled error states. `useTransition` keeps the
 * button disabled while the request is in flight, so double-clicks cannot
 * fire a second request.
 */
export function TestNotificationButton({
  channelId,
  labels,
}: {
  channelId: number;
  labels: TestNotificationButtonLabels;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<
    { kind: "success"; text: string } | { kind: "error"; text: string } | null
  >(null);

  function handleSend() {
    setFeedback(null);

    startTransition(async () => {
      const result = await sendTestNotificationAction(channelId);

      if (!result.ok) {
        setFeedback({ kind: "error", text: result.error });
        return;
      }

      setFeedback({ kind: "success", text: labels.success });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {feedback ? (
        <p
          role="alert"
          className={`text-xs ${feedback.kind === "success" ? "text-green-600" : "text-red-600"}`}
        >
          {feedback.text}
        </p>
      ) : null}
      <button
        type="button"
        onClick={handleSend}
        disabled={isPending}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {isPending ? labels.sending : labels.send}
      </button>
    </div>
  );
}
