import Link from "next/link";
import { notFound } from "next/navigation";
import { getDomainById } from "@/lib/domains";
import { formatDate } from "@/lib/format";
import { RefreshRdapButton } from "@/components/refresh-rdap-button";
import { CheckDnsButton } from "@/components/check-dns-button";
import { CheckSslButton } from "@/components/check-ssl-button";
import { getDnsSnapshots, getLatestDnsSnapshot } from "@/lib/dns/repository";
import { diffDnsSnapshots } from "@/lib/dns";
import { DNS_RECORD_TYPES, type DnsRecord } from "@/lib/dns";
import { getSslHistory, getLatestSslSnapshot } from "@/lib/ssl/repository";
import { daysRemaining, type SslStatus } from "@/lib/ssl";

export const dynamic = "force-dynamic";

function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-gray-900">
        {value ? value : <span className="font-normal text-gray-400">Not available</span>}
      </dd>
    </div>
  );
}

/** Fingerprint row: hex strings need break-all to wrap on narrow screens. */
function FingerprintRow({ value }: { value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-gray-500">Fingerprint</dt>
      <dd className="min-w-0 break-all text-right font-mono text-xs text-gray-900">{value}</dd>
    </div>
  );
}

/** Display form of a record value (MX shows "10 mail.example.com"). */
function formatRecordValue(record: DnsRecord): string {
  return record.type === "MX" && record.priority !== undefined
    ? `${record.priority} ${record.value}`
    : record.value;
}

/** SSL status badge: label + color classes, mirroring the DNS status pill. */
function SslStatusBadge({ status }: { status: SslStatus }) {
  const config: Record<SslStatus, { label: string; className: string; dot: string }> = {
    ok: {
      label: "Valid",
      className: "bg-green-50 text-green-700",
      dot: "bg-green-500",
    },
    expires_soon: {
      label: "Expires soon",
      className: "bg-amber-50 text-amber-700",
      dot: "bg-amber-500",
    },
    expired: {
      label: "Expired",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
    },
    mismatch: {
      label: "Hostname mismatch",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
    },
    error: {
      label: "Error",
      className: "bg-gray-100 text-gray-600",
      dot: "bg-gray-400",
    },
  };
  const { label, className, dot } = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
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

  const latestSsl = getLatestSslSnapshot(domain.id);
  const sslHistory = getSslHistory(domain.id, 10);

  const upcomingModules = [
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

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">SSL Certificate Monitoring</h2>
          <CheckSslButton domainId={domain.id} />
        </div>

        <div className="border-b border-gray-100 px-4 py-3 text-sm">
          <span className="text-gray-500">Last checked:</span>{" "}
          <span className="font-medium text-gray-900">
            {latestSsl ? formatDate(latestSsl.checkedAt) : "Never checked"}
          </span>
        </div>

        {latestSsl && latestSsl.status !== "error" && latestSsl.certificate ? (
          <>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 text-sm">
              <dt className="text-gray-500">Certificate status</dt>
              <dd>
                <SslStatusBadge status={latestSsl.status} />
                {latestSsl.certificate.validTo ? (
                  <span className="ml-2 text-gray-600">
                    {formatDate(new Date(latestSsl.certificate.validTo))}
                    {` (${daysRemaining(new Date(latestSsl.certificate.validTo))} days remaining)`}
                  </span>
                ) : null}
              </dd>
            </div>
            <dl className="divide-y divide-gray-100 text-sm">
              <InfoRow label="Issuer" value={latestSsl.certificate.issuer ?? undefined} />
              <InfoRow label="Subject" value={latestSsl.certificate.subject ?? undefined} />
              <InfoRow
                label="SAN"
                value={
                  latestSsl.certificate.san.length > 0
                    ? latestSsl.certificate.san.join(", ")
                    : undefined
                }
              />
              <FingerprintRow value={latestSsl.certificate.fingerprint256} />
              <InfoRow label="TLS version" value={latestSsl.tlsVersion ?? undefined} />
              <InfoRow label="Cipher" value={latestSsl.cipherName ?? undefined} />
            </dl>
          </>
        ) : latestSsl && latestSsl.status === "error" ? (
          <p className="px-4 py-6 text-sm text-gray-500">SSL monitoring unavailable.</p>
        ) : null}

        <div className="px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            SSL History
          </h3>
          {sslHistory.length > 0 ? (
            <ul className="divide-y divide-gray-50 text-sm">
              {sslHistory.map((snapshot, index) => {
                const previous = index + 1 < sslHistory.length ? sslHistory[index + 1] : undefined;
                const replaced =
                  previous &&
                  previous.certificate &&
                  snapshot.certificate &&
                  previous.certificate.fingerprint256 !== snapshot.certificate.fingerprint256;
                return (
                  <li key={snapshot.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-gray-900">{formatDate(snapshot.checkedAt)}</span>
                    <span
                      className={
                        snapshot.status === "expired" || snapshot.status === "mismatch"
                          ? "font-medium text-red-600"
                          : snapshot.status === "expires_soon"
                            ? "font-medium text-amber-600"
                            : snapshot.status === "error"
                              ? "text-gray-500"
                              : "text-gray-500"
                      }
                    >
                      {previous === undefined
                        ? "First check"
                        : snapshot.status === "error"
                          ? "Unavailable"
                          : replaced
                            ? "Certificate replaced"
                            : "No changes"}
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
