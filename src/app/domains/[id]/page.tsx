import Link from "next/link";
import { notFound } from "next/navigation";
import { getDomainById } from "@/lib/domains";
import { formatDate } from "@/lib/format";
import { getDictionary, getLocale } from "@/lib/i18n";
import { interpolate } from "@/lib/i18n/config";
import { errorMessage, lookup } from "@/lib/i18n/display";
import type { Dictionary } from "@/lib/i18n/en";
import { RefreshRdapButton } from "@/components/refresh-rdap-button";
import { CheckDnsButton } from "@/components/check-dns-button";
import { CheckSslButton } from "@/components/check-ssl-button";
import { CheckHttpButton } from "@/components/check-http-button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { LogoutButton } from "@/components/auth/logout-button";
import { requirePageAccess } from "@/lib/auth/admin";
import { getDnsSnapshots, getLatestDnsSnapshot } from "@/lib/dns/repository";
import { diffDnsSnapshots } from "@/lib/dns";
import { DNS_RECORD_TYPES, type DnsRecord } from "@/lib/dns";
import { getSslHistory, getLatestSslSnapshot } from "@/lib/ssl/repository";
import { daysRemaining, type SslStatus } from "@/lib/ssl";
import { getHttpHistory, getLatestHttpSnapshot } from "@/lib/http/repository";
import { type HttpStatus } from "@/lib/http";
import type { Locale } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

function InfoRow({ label, value, dict }: { label: string; value?: string; dict: Dictionary }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-gray-500">{lookup(dict, label)}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-gray-900">
        {value ? (
          value
        ) : (
          <span className="font-normal text-gray-400">{lookup(dict, "common.notAvailable")}</span>
        )}
      </dd>
    </div>
  );
}

/** Fingerprint row: hex strings need break-all to wrap on narrow screens. */
function FingerprintRow({ value, dict }: { value: string; dict: Dictionary }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-gray-500">{lookup(dict, "ssl.fingerprint")}</dt>
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
function SslStatusBadge({ status, dict }: { status: SslStatus; dict: Dictionary }) {
  const config: Record<SslStatus, { key: string; className: string; dot: string }> = {
    ok: {
      key: "status.valid",
      className: "bg-green-50 text-green-700",
      dot: "bg-green-500",
    },
    expires_soon: {
      key: "status.expiresSoon",
      className: "bg-amber-50 text-amber-700",
      dot: "bg-amber-500",
    },
    expired: {
      key: "status.expired",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
    },
    mismatch: {
      key: "status.mismatch",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
    },
    error: {
      key: "status.error",
      className: "bg-gray-100 text-gray-600",
      dot: "bg-gray-400",
    },
  };
  const { key, className, dot } = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} />
      {lookup(dict, key)}
    </span>
  );
}

/** HTTP status badge, mirroring the SSL badge style. */
function HttpStatusBadge({ status, dict }: { status: HttpStatus; dict: Dictionary }) {
  const config: Record<HttpStatus, { key: string; className: string; dot: string }> = {
    ok: {
      key: "status.up",
      className: "bg-green-50 text-green-700",
      dot: "bg-green-500",
    },
    client_error: {
      key: "status.clientError",
      className: "bg-amber-50 text-amber-700",
      dot: "bg-amber-500",
    },
    server_error: {
      key: "status.serverError",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
    },
    down: {
      key: "status.down",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
    },
    error: {
      key: "status.error",
      className: "bg-gray-100 text-gray-600",
      dot: "bg-gray-400",
    },
  };
  const { key, className, dot } = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} />
      {lookup(dict, key)}
    </span>
  );
}

export default async function DomainDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess();
  const { id } = await params;
  const domainId = Number(id);

  if (!Number.isInteger(domainId) || domainId <= 0) {
    notFound();
  }

  const domain = getDomainById(domainId);

  if (!domain) {
    notFound();
  }

  const locale: Locale = await getLocale();
  const dict = getDictionary(locale);

  const rdapAvailable = domain.rdapUpdatedAt !== null;

  const latestSnapshot = getLatestDnsSnapshot(domain.id);
  const history = getDnsSnapshots(domain.id, 10);
  // Latest check's changes = diff between the two most recent snapshots.
  const latestChanges = history.length >= 2 ? diffDnsSnapshots(history[1], history[0]) : [];

  const latestSsl = getLatestSslSnapshot(domain.id);
  const sslHistory = getSslHistory(domain.id, 10);

  const latestHttp = getLatestHttpSnapshot(domain.id);
  const httpHistory = getHttpHistory(domain.id, 10);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <nav className="mb-6 flex items-center justify-between gap-4">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 hover:underline">
          {lookup(dict, "nav.backToDashboard")}
        </Link>
        <div className="flex items-center gap-3">
          <LanguageSwitcher locale={locale} />
          <LogoutButton label={dict.auth.logout} />
        </div>
      </nav>

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">{domain.hostname}</h1>
      </header>

      <section className="mb-10 rounded-lg border border-gray-200">
        <dl className="divide-y divide-gray-100 text-sm">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">{lookup(dict, "domains.col.domain")}</dt>
            <dd className="font-medium text-gray-900">{domain.hostname}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">{lookup(dict, "domains.col.status")}</dt>
            <dd>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                <span className="size-1.5 rounded-full bg-green-500" />
                {domain.status === "active" ? lookup(dict, "status.active") : domain.status}
              </span>
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">{lookup(dict, "domains.col.created")}</dt>
            <dd className="text-gray-900">{formatDate(domain.createdAt, locale)}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500">{lookup(dict, "common.lastUpdated")}</dt>
            <dd className="text-gray-900">{formatDate(domain.updatedAt, locale)}</dd>
          </div>
        </dl>
      </section>

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {lookup(dict, "rdap.sectionTitle")}
          </h2>
          <RefreshRdapButton
            id={domain.id}
            labels={{
              refresh: lookup(dict, "actions.refreshRdap"),
              refreshing: lookup(dict, "actions.refreshing"),
            }}
          />
        </div>

        {rdapAvailable ? (
          <dl className="divide-y divide-gray-100 text-sm">
            <InfoRow label="rdap.registrar" value={domain.registrar ?? undefined} dict={dict} />
            <InfoRow
              label="rdap.registration"
              value={
                domain.registrationDate
                  ? formatDate(new Date(domain.registrationDate), locale)
                  : undefined
              }
              dict={dict}
            />
            <InfoRow
              label="rdap.expiration"
              value={
                domain.expirationDate
                  ? formatDate(new Date(domain.expirationDate), locale)
                  : undefined
              }
              dict={dict}
            />
            <InfoRow
              label="common.lastUpdated"
              value={
                domain.updatedDate ? formatDate(new Date(domain.updatedDate), locale) : undefined
              }
              dict={dict}
            />
            <InfoRow
              label="rdap.nameservers"
              value={domain.nameservers.length > 0 ? domain.nameservers.join(", ") : undefined}
              dict={dict}
            />
            <InfoRow
              label="rdap.status"
              value={domain.rdapStatus.length > 0 ? domain.rdapStatus.join(", ") : undefined}
              dict={dict}
            />
          </dl>
        ) : (
          <p className="px-4 py-6 text-sm text-gray-500">{lookup(dict, "rdap.unavailable")}</p>
        )}
      </section>

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {lookup(dict, "dns.sectionTitle")}
          </h2>
          <CheckDnsButton
            domainId={domain.id}
            dict={dict}
            labels={{
              check: lookup(dict, "actions.checkDns"),
              checking: lookup(dict, "actions.checking"),
            }}
          />
        </div>

        <div className="border-b border-gray-100 px-4 py-3 text-sm">
          <span className="text-gray-500">{lookup(dict, "dns.lastChecked")}</span>{" "}
          <span className="font-medium text-gray-900">
            {latestSnapshot
              ? formatDate(latestSnapshot.checkedAt, locale)
              : lookup(dict, "dns.neverChecked")}
          </span>
        </div>

        {latestChanges.length > 0 ? (
          <div className="border-b border-gray-100 px-4 py-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {lookup(dict, "dns.changesTitle")}
            </h3>
            <ul className="space-y-1.5 text-sm">
              {latestChanges.map((change, index) => (
                <li
                  key={index}
                  className={change.type === "RECORD_ADDED" ? "text-green-700" : "text-red-600"}
                >
                  <span className="font-medium">
                    {change.type === "RECORD_ADDED"
                      ? interpolate(lookup(dict, "dns.recordAdded"), { type: change.record.type })
                      : interpolate(lookup(dict, "dns.recordRemoved"), {
                          type: change.record.type,
                        })}
                  </span>{" "}
                  — <span className="font-mono">{formatRecordValue(change.record)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="border-b border-gray-100 px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {lookup(dict, "dns.recordsTitle")}
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
              {latestSnapshot
                ? lookup(dict, "dns.empty.records")
                : lookup(dict, "dns.empty.runCheck")}
            </p>
          )}
        </div>

        <div className="px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {lookup(dict, "dns.historyTitle")}
          </h3>
          {history.length > 0 ? (
            <ul className="divide-y divide-gray-50 text-sm">
              {history.map((snapshot, index) => {
                const previous = index + 1 < history.length ? history[index + 1] : undefined;
                const changeCount = previous ? diffDnsSnapshots(previous, snapshot).length : 0;
                return (
                  <li key={snapshot.id} className="flex items-center justify-between py-1.5">
                    <span className="text-gray-900">{formatDate(snapshot.checkedAt, locale)}</span>
                    <span
                      className={changeCount > 0 ? "font-medium text-amber-600" : "text-gray-500"}
                    >
                      {previous === undefined
                        ? lookup(dict, "history.firstCheck")
                        : changeCount === 0
                          ? lookup(dict, "history.noChanges")
                          : interpolate(lookup(dict, "history.recordsChanged"), {
                              count: changeCount,
                            })}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">{lookup(dict, "history.noChecks")}</p>
          )}
        </div>
      </section>

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {lookup(dict, "ssl.sectionTitle")}
          </h2>
          <CheckSslButton
            domainId={domain.id}
            dict={dict}
            labels={{
              check: lookup(dict, "actions.checkSsl"),
              checking: lookup(dict, "actions.checking"),
            }}
          />
        </div>

        <div className="border-b border-gray-100 px-4 py-3 text-sm">
          <span className="text-gray-500">{lookup(dict, "dns.lastChecked")}</span>{" "}
          <span className="font-medium text-gray-900">
            {latestSsl ? formatDate(latestSsl.checkedAt, locale) : lookup(dict, "dns.neverChecked")}
          </span>
        </div>

        {latestSsl && latestSsl.status !== "error" && latestSsl.certificate ? (
          <>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 text-sm">
              <dt className="text-gray-500">{lookup(dict, "ssl.certStatus")}</dt>
              <dd>
                <SslStatusBadge status={latestSsl.status} dict={dict} />
                {latestSsl.certificate.validTo ? (
                  <span className="ml-2 text-gray-600">
                    {formatDate(new Date(latestSsl.certificate.validTo), locale)}
                    {` (${interpolate(lookup(dict, "ssl.daysRemaining"), {
                      count: daysRemaining(new Date(latestSsl.certificate.validTo)),
                    })})`}
                  </span>
                ) : null}
              </dd>
            </div>
            <dl className="divide-y divide-gray-100 text-sm">
              <InfoRow
                label="ssl.issuer"
                value={latestSsl.certificate.issuer ?? undefined}
                dict={dict}
              />
              <InfoRow
                label="ssl.subject"
                value={latestSsl.certificate.subject ?? undefined}
                dict={dict}
              />
              <InfoRow
                label="ssl.san"
                value={
                  latestSsl.certificate.san.length > 0
                    ? latestSsl.certificate.san.join(", ")
                    : undefined
                }
                dict={dict}
              />
              <FingerprintRow value={latestSsl.certificate.fingerprint256} dict={dict} />
              <InfoRow
                label="ssl.tlsVersion"
                value={latestSsl.tlsVersion ?? undefined}
                dict={dict}
              />
              <InfoRow label="ssl.cipher" value={latestSsl.cipherName ?? undefined} dict={dict} />
            </dl>
          </>
        ) : latestSsl && latestSsl.status === "error" ? (
          <p className="px-4 py-6 text-sm text-gray-500">
            {errorMessage(latestSsl.error ?? "", dict) ?? lookup(dict, "ssl.unavailable")}
          </p>
        ) : null}

        <div className="px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {lookup(dict, "ssl.historyTitle")}
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
                    <span className="text-gray-900">{formatDate(snapshot.checkedAt, locale)}</span>
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
                        ? lookup(dict, "history.firstCheck")
                        : snapshot.status === "error"
                          ? (errorMessage(snapshot.error ?? "", dict) ??
                            lookup(dict, "ssl.unavailable"))
                          : replaced
                            ? lookup(dict, "ssl.certReplaced")
                            : lookup(dict, "history.noChanges")}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">{lookup(dict, "history.noChecks")}</p>
          )}
        </div>
      </section>

      <section className="mb-10 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {lookup(dict, "http.sectionTitle")}
          </h2>
          <CheckHttpButton
            domainId={domain.id}
            dict={dict}
            labels={{
              check: lookup(dict, "actions.checkHttp"),
              checking: lookup(dict, "actions.checking"),
            }}
          />
        </div>

        <div className="border-b border-gray-100 px-4 py-3 text-sm">
          <span className="text-gray-500">{lookup(dict, "dns.lastChecked")}</span>{" "}
          <span className="font-medium text-gray-900">
            {latestHttp
              ? formatDate(latestHttp.checkedAt, locale)
              : lookup(dict, "dns.neverChecked")}
          </span>
        </div>

        {latestHttp && latestHttp.status !== "error" ? (
          <dl className="divide-y divide-gray-100 text-sm">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="shrink-0 text-gray-500">{lookup(dict, "domains.col.status")}</dt>
              <dd className="flex items-center gap-2 text-right font-medium text-gray-900">
                <HttpStatusBadge status={latestHttp.status} dict={dict} />
                {latestHttp.httpStatus !== undefined ? (
                  <span className="text-gray-600">
                    {interpolate(lookup(dict, "http.httpStatus"), {
                      code: latestHttp.httpStatus,
                    })}
                  </span>
                ) : null}
                {latestHttp.responseTimeMs !== undefined ? (
                  <span className="text-gray-600">
                    {interpolate(lookup(dict, "http.responseTime"), {
                      ms: latestHttp.responseTimeMs,
                    })}
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="shrink-0 text-gray-500">{lookup(dict, "http.redirects")}</dt>
              <dd className="text-right font-medium text-gray-900">
                {latestHttp.redirectCount > 0 ? (
                  <span>
                    {latestHttp.redirectCount} ({latestHttp.finalUrl ?? ""})
                  </span>
                ) : (
                  lookup(dict, "http.none")
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="shrink-0 text-gray-500">{lookup(dict, "http.finalUrl")}</dt>
              <dd className="min-w-0 break-all text-right font-mono text-xs text-gray-900">
                {latestHttp.finalUrl ?? "—"}
              </dd>
            </div>
          </dl>
        ) : latestHttp && latestHttp.status === "error" ? (
          <p className="px-4 py-6 text-sm text-gray-500">
            {errorMessage(latestHttp.error ?? "", dict) ?? lookup(dict, "http.unavailable")}
          </p>
        ) : null}

        <div className="px-4 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {lookup(dict, "http.historyTitle")}
          </h3>
          {httpHistory.length > 0 ? (
            <ul className="divide-y divide-gray-50 text-sm">
              {httpHistory.map((snapshot, index) => {
                const previous =
                  index + 1 < httpHistory.length ? httpHistory[index + 1] : undefined;
                const statusChanged = previous !== undefined && previous.status !== snapshot.status;
                return (
                  <li key={snapshot.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-gray-900">{formatDate(snapshot.checkedAt, locale)}</span>
                    <span
                      className={
                        snapshot.status === "server_error" || snapshot.status === "down"
                          ? "font-medium text-red-600"
                          : snapshot.status === "client_error"
                            ? "font-medium text-amber-600"
                            : snapshot.status === "error"
                              ? "text-gray-500"
                              : "text-gray-500"
                      }
                    >
                      {previous === undefined
                        ? lookup(dict, "history.firstCheck")
                        : snapshot.status === "error"
                          ? (errorMessage(snapshot.error ?? "", dict) ??
                            lookup(dict, "http.unavailable"))
                          : statusChanged
                            ? interpolate(lookup(dict, "http.statusChanged"), {
                                status: snapshot.status,
                              })
                            : snapshot.httpStatus !== undefined
                              ? `${interpolate(lookup(dict, "http.httpStatus"), {
                                  code: snapshot.httpStatus,
                                })}${snapshot.responseTimeMs !== undefined ? ` · ${interpolate(lookup(dict, "http.responseTime"), { ms: snapshot.responseTimeMs })}` : ""}`
                              : snapshot.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">{lookup(dict, "history.noChecks")}</p>
          )}
        </div>
      </section>
    </main>
  );
}
