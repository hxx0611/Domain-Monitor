import { eventTypeLabel } from "@/lib/notifications/events";
import { formatDate } from "@/lib/format";
import type { DeliveryView } from "@/lib/notifications/actions";
import { DeliveryStatusBadge } from "./badges";
import { RetryDeliveryButton } from "./retry-delivery-button";

/**
 * Delivery history table (server component). Failed rows get a Retry
 * button (client component) that calls the server action — the UI never
 * touches senders or repository functions directly. The error column
 * renders the DB error text as-is (senders guarantee secret-free messages).
 */
export function DeliveriesTable({ deliveries }: { deliveries: DeliveryView[] }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Delivery History
      </h2>

      {deliveries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">No deliveries yet.</p>
          <p className="mt-1 text-sm text-gray-500">
            Events matched by rules will appear here as they are sent.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="px-4 py-3 font-medium">
                  Event
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Channel
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Attempts
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Time
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Error
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.deliveryId} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="font-medium text-gray-900">
                      {eventTypeLabel(delivery.eventType)}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {delivery.hostname ?? `event #${delivery.eventId}`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{delivery.channelName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <DeliveryStatusBadge status={delivery.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{delivery.attempts}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="block">{formatDate(delivery.createdAt)}</span>
                    {delivery.deliveredAt ? (
                      <span className="block text-xs text-gray-400">
                        Delivered: {formatDate(delivery.deliveredAt)}
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
                      <RetryDeliveryButton deliveryId={delivery.deliveryId} />
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
