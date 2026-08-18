import Link from "next/link";
import { getDomains } from "@/lib/domains";
import { formatDate } from "@/lib/format";
import { getDictionary, getLocale } from "@/lib/i18n";
import { interpolate } from "@/lib/i18n/config";
import { requirePageAccess } from "@/lib/auth/admin";
import { AddDomainForm } from "@/components/add-domain-form";
import { DeleteDomainButton } from "@/components/delete-domain-button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { LogoutButton } from "@/components/auth/logout-button";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requirePageAccess();
  const domains = getDomains();
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-12">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{dict.common.appName}</h1>
          <p className="mt-1 text-sm text-gray-500">{dict.home.tagline}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <Link
            href="/notifications"
            className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
          >
            {dict.nav.notifications}
          </Link>
          <LanguageSwitcher locale={locale} />
          <LogoutButton label={dict.auth.logout} />
        </div>
      </header>

      <AddDomainForm
        labels={{
          add: dict.actions.addDomain,
          adding: dict.actions.adding,
          cancel: dict.actions.cancel,
          domain: dict.domains.col.domain,
          formHint: dict.domains.formHint,
        }}
      />

      <section className="mt-10">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
          {dict.domains.listTitle}
        </h2>

        {domains.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-16 text-center">
            <p className="text-sm font-medium text-gray-700">{dict.domains.empty.title}</p>
            <p className="mt-1 text-sm text-gray-500">{dict.domains.empty.hint}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <th scope="col" className="px-4 py-3 font-medium">
                    {dict.domains.col.domain}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {dict.domains.col.status}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {dict.domains.col.expiration}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {dict.domains.col.created}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    {dict.domains.col.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <tr key={domain.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="px-4 py-3 font-medium text-gray-900">{domain.hostname}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                        <span className="size-1.5 rounded-full bg-green-500" />
                        {domain.status === "active" ? dict.status.active : domain.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {domain.expirationDate ? (
                        <span>
                          {interpolate(dict.domains.expires, {
                            date: formatDate(new Date(domain.expirationDate), locale),
                          })}
                        </span>
                      ) : (
                        <span className="text-gray-400">{dict.domains.expirationUnavailable}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {formatDate(domain.createdAt, locale)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/domains/${domain.id}`}
                          className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {dict.actions.view}
                        </Link>
                        <DeleteDomainButton
                          id={domain.id}
                          hostname={domain.hostname}
                          labels={{
                            delete: dict.actions.delete,
                            deleting: dict.actions.deleting,
                            confirmTemplate: dict.actions.deleteConfirm,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
