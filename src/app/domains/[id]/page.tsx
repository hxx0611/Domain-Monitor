import Link from "next/link";
import { notFound } from "next/navigation";
import { getDomainById } from "@/lib/domains";
import { formatDate } from "@/lib/format";
import { RefreshRdapButton } from "@/components/refresh-rdap-button";
import { CheckDnsButton } from "@/components/check-dns-button";
import { getDnsSnapshots, getLatestDnsSnapshot } from "@/lib/dns/repository";
import { diffDnsSnapshots } from "@/lib/dns";
import { DNS_RECORD_TYPES, type DnsRecord } from "@/lib/dns";

export const dynamic = "force-dynamic";

function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-900">
        {value ? value : <span className="font-normal text-gray-400">Not available</span>}
      </dd>
    </div>
  );
}

/** Display form of a record value (MX shows "10 mail.example.com"). */
function formatRecordValue(record: DnsRecord): string {
  return record.type === "MX" && record.priority !== undefined
    ? `${record.priority} ${record.value}`
    : record.value;
}

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

  const rdapAvailable = domain.rdapUpdatedAt !== null;

  const latestSnapshot = getLatestDnsSnapshot(domain.id);
  const history = getDnsSnapshots(domain.id, 10);
  // Latest check's changes = diff between the two most recent snapshots.
  const latestChanges = history.length >= 2 ? diffDnsSnapshots(history[1], history[0]) : [];

  const upcomingModules = [
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

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Domain Information</h2>
          <RefreshRdapButton id={domain.id} />
        </div>

        {rdapAvailable ? (
          <dl className="divide-y divide-gray-100 text-sm">
            <InfoRow label="Registrar" value={domain.registrar ?? undefined} />
            <InfoRow
              label="Registration"
              value={
                domain.registrationDate ? formatDate(new Date(domain.registrationDate)) : undefined
              }
            />
            <InfoRow
              label="Expiration"
              value={
                domain.expirationDate ? formatDate(new Date(domain.expirationDate)) : undefined
              }
            />
            <InfoRow
              label="Last updated"
              value={domain.updatedDate ? formatDate(new Date(domain.updatedDate)) : undefined}
            />
            <InfoRow
              label="Nameservers"
              value={domain.nameservers.length > 0 ? domain.nameservers.join(", ") : undefined}
            />
            <InfoRow
              label="Status"
              value={domain.rdapStatus.length > 0 ? domain.rdapStatus.join(", ") : undefined}
            />
          </dl>
        ) : (
          <p className="px-4 py-6 text-sm text-gray-500">RDAP information unavailable.</p>
        )}
      </section>

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">DNS Monitoring</h2>
          <CheckDnsButton domainId={domain.id} />
        </div>

        <div className="border-b border-gray-100 px-4 py-3 text-sm">
          <span className="text-gray-500">Last checked:</span>{" "}
          <span className="font-medium text-gray-900">
            {latestSnapshot ? formatDate(latestSnapshot.checkedAt) : "Never checked"}
          </span>
        </div>

        {latestChanges.length > 0 ? (
          <div className="border-b border-gray-100 px-4 py-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              DNS Changes
            </h3>
            <ul className="space-y-1.5 text-sm">
              {latestChanges.map((change, index) => (
                <li
                  key={index}
                  className={change.type === "RECORD_ADDED" ? "text-green-700" : "text-red-600"}
                >
                  <span className="font-medium">
                    {change.record.type} record{" "}
                    {change.type === "RECORD_ADDED" ? "added" : "removed"}
                  </span>{" "}
                  — <span className="font-mono">{formatRecordValue(change.record)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="border-b border-gray-100 px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            DNS Records
          </h3>
          {latestSnapshot && latestSnapshot.records.length > 0 ? (
            <div className="space-y-4">
              {DNS_RECORD_TYPES.map((type) => {
                const typeRecords = latestSnapshot.records.filter((record) => record.type === type);
                if (typeRecords.length === 0) {
                  return null;
                }
                return (
                  <div key={type}>
                    <h4 className="text-xs font-semibold text-gray-400">{type}</h4>
                    <ul className="mt-1 space-y-0.5 font-mono text-sm text-gray-900">
                      {typeRecords.map((record, index) => (
                        <li key={index}>{formatRecordValue(record)}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              {latestSnapshot ? "No records found." : "Run a DNS check to see records."}
            </p>
          )}
        </div>

        <div className="px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            DNS History
          </h3>
          {history.length > 0 ? (
            <ul className="divide-y divide-gray-50 text-sm">
              {history.map((snapshot, index) => {
                const previous = index + 1 < history.length ? history[index + 1] : undefined;
                const changeCount = previous ? diffDnsSnapshots(previous, snapshot).length : 0;
                return (
                  <li key={snapshot.id} className="flex items-center justify-between py-1.5">
                    <span className="text-gray-900">{formatDate(snapshot.checkedAt)}</span>
                    <span
                      className={changeCount > 0 ? "font-medium text-amber-600" : "text-gray-500"}
                    >
                      {previous === undefined
                        ? "First check"
                        : changeCount === 0
                          ? "No changes"
                          : `${changeCount} record${changeCount === 1 ? "" : "s"} changed`}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">No checks yet.</p>
          )}
        </div>
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
