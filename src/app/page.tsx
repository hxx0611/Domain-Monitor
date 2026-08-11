import Link from "next/link";
import { getDomains } from "@/lib/domains";
import { formatDate } from "@/lib/format";
import { AddDomainForm } from "@/components/add-domain-form";
import { DeleteDomainButton } from "@/components/delete-domain-button";

export const dynamic = "force-dynamic";

export default function Home() {
  const domains = getDomains();

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Domain Monitor</h1>
        <p className="mt-1 text-sm text-gray-500">Open-source domain lifecycle monitoring.</p>
      </header>

      <AddDomainForm />

      <section className="mt-10">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Monitored domains
        </h2>

        {domains.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-16 text-center">
            <p className="text-sm font-medium text-gray-700">No domains yet.</p>
            <p className="mt-1 text-sm text-gray-500">
              Add your first domain to start monitoring it.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Domain
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Expiration
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Actions
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
                        {domain.status === "active" ? "Active" : domain.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {domain.expirationDate ? (
                        <span>Expires: {formatDate(new Date(domain.expirationDate))}</span>
                      ) : (
                        <span className="text-gray-400">Expiration unavailable</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{formatDate(domain.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/domains/${domain.id}`}
                          className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          View
                        </Link>
                        <DeleteDomainButton id={domain.id} hostname={domain.hostname} />
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
