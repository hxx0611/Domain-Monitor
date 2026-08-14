import Link from "next/link";
import { getNotificationsOverviewAction } from "@/lib/notifications/actions";
import { ChannelsTable } from "@/components/notifications/channels-table";
import { RulesTable } from "@/components/notifications/rules-table";
import { DeliveriesTable } from "@/components/notifications/deliveries-table";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const result = await getNotificationsOverviewAction();

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-12">
      <nav className="mb-6">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 hover:underline">
          ← Back to dashboard
        </Link>
      </nav>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-gray-500">
          Delivery channels, rules, and event delivery history.
        </p>
      </header>

      {result.ok ? (
        <>
          <ChannelsTable channels={result.channels} />
          <RulesTable rules={result.rules} />
          <DeliveriesTable deliveries={result.deliveries} />
        </>
      ) : (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {result.error}
        </div>
      )}
    </main>
  );
}
