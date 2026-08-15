import Link from "next/link";
import { getNotificationsOverviewAction } from "@/lib/notifications/actions";
import { getDictionary, getLocale } from "@/lib/i18n";
import { lookup } from "@/lib/i18n/display";
import { ChannelsTable } from "@/components/notifications/channels-table";
import { RulesTable } from "@/components/notifications/rules-table";
import { DeliveriesTable } from "@/components/notifications/deliveries-table";
import { LanguageSwitcher } from "@/components/language-switcher";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const result = await getNotificationsOverviewAction();
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-12">
      <nav className="mb-6 flex items-center justify-between gap-4">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 hover:underline">
          {lookup(dict, "nav.backToDashboard")}
        </Link>
        <LanguageSwitcher locale={locale} />
      </nav>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">{lookup(dict, "nav.notifications")}</h1>
        <p className="mt-1 text-sm text-gray-500">{lookup(dict, "notifications.tagline")}</p>
      </header>

      {result.ok ? (
        <>
          <ChannelsTable channels={result.channels} dict={dict} />
          <RulesTable rules={result.rules} dict={dict} />
          <DeliveriesTable deliveries={result.deliveries} dict={dict} locale={locale} />
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
