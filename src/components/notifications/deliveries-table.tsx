import { formatDate } from "@/lib/format";
import type { DeliveryView } from "@/lib/notifications/actions";
import type { Dictionary } from "@/lib/i18n/en";
import { interpolate } from "@/lib/i18n/config";
import { eventTypeLabel, lookup } from "@/lib/i18n/display";
import type { Locale } from "@/lib/i18n/config";
import { DeliveryStatusBadge } from "./badges";
import { RetryDeliveryButton } from "./retry-delivery-button";

/**
 * Delivery history table (server component). Failed rows get a Retry
 * button (client component) that calls the server action — the UI never
 * touches senders or repository functions directly. The error column
 * renders the DB error text as-is (senders guarantee secret-free messages;
 * error text is never translated).
 */
export function DeliveriesTable({
  deliveries,
  dict,
  locale,
}: {
  deliveries: DeliveryView[];
  dict: Dictionary;
  locale: Locale;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
        {lookup(dict, "deliveries.title")}
      </h2>

      {deliveries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">
            {lookup(dict, "deliveries.empty.title")}
          </p>
          <p className="mt-1 text-sm text-gray-500">{lookup(dict, "deliveries.empty.hint")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "deliveries.col.event")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "deliveries.col.channel")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "deliveries.col.status")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "deliveries.col.attempts")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "deliveries.col.time")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "deliveries.col.error")}
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  {lookup(dict, "deliveries.col.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.deliveryId} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="font-medium text-gray-900">
                      {eventTypeLabel(delivery.eventType, dict)}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {delivery.hostname ?? `event #${delivery.eventId}`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{delivery.channelName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <DeliveryStatusBadge status={delivery.status} dict={dict} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{delivery.attempts}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="block">{formatDate(delivery.createdAt, locale)}</span>
                    {delivery.deliveredAt ? (
                      <span className="block text-xs text-gray-400">
                        {interpolate(lookup(dict, "deliveries.deliveredAt"), {
                          date: formatDate(delivery.deliveredAt, locale),
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    {delivery.error ? (
                      <span className="block break-words text-xs text-red-600">
                        {delivery.error}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {delivery.status === "failed" ? (
                      <RetryDeliveryButton
                        deliveryId={delivery.deliveryId}
                        labels={{
                          retry: lookup(dict, "actions.retry"),
                          retrying: lookup(dict, "actions.retrying"),
                        }}
                      />
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
