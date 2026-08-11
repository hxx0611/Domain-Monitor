import Link from "next/link";
import { notFound } from "next/navigation";
import { getDomainById } from "@/lib/domains";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DomainDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const domainId = Number(id);

  if (!Number.isInteger(domainId) || domainId <= 0) {
    notFound();
  }

  const domain = getDomainById(domainId);

  if (!domain) {
    notFound();
  }

  const upcomingModules = [
    { title: "Domain Information", description: "RDAP / WHOIS registration data" },
    { title: "DNS", description: "Record monitoring and resolution checks" },
    { title: "SSL", description: "Certificate validity and expiry tracking" },
    { title: "HTTP", description: "Uptime and response health checks" },
  ] as const;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <nav className="mb-6">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 hover:underline">
          ← Back to dashboard
        </Link>
      </nav>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">{domain.hostname}</h1>
      </header>

      <section className="mb-10 rounded-lg border border-gray-200">
        <dl className="divide-y divide-gray-100 text-sm">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">Domain</dt>
            <dd className="font-medium text-gray-900">{domain.hostname}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">Status</dt>
            <dd>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                <span className="size-1.5 rounded-full bg-green-500" />
                {domain.status === "active" ? "Active" : domain.status}
              </span>
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">Created</dt>
            <dd className="text-gray-900">{formatDate(domain.createdAt)}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">Last updated</dt>
            <dd className="text-gray-900">{formatDate(domain.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Monitoring modules
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {upcomingModules.map((module) => (
            <div key={module.title} className="rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-900">{module.title}</h3>
              <p className="mt-1 text-xs text-gray-500">{module.description}</p>
              <p className="mt-3 text-xs font-medium text-gray-400">Coming soon</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
