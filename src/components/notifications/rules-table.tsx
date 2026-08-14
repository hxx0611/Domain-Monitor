import { eventTypeLabel } from "@/lib/notifications/events";
import type { RuleView } from "@/lib/notifications/actions";
import { EnabledBadge } from "./badges";

const SOURCE_LABELS: Record<string, string> = {
  dns: "DNS",
  ssl: "SSL",
  http: "HTTP",
};

/**
 * Notification rules table (server component, pure display). Filters are
 * shown friendly: null source / event type / domain render as "All".
 */
export function RulesTable({ rules }: { rules: RuleView[] }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Notification Rules
      </h2>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">No rules yet.</p>
          <p className="mt-1 text-sm text-gray-500">
            Rules decide which events are sent to which channels.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="px-4 py-3 font-medium">
                  Source
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Event type
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Domain
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Channel
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {rule.source ? (SOURCE_LABELS[rule.source] ?? rule.source) : "All"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {rule.eventType ? eventTypeLabel(rule.eventType) : "All"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{rule.hostname ?? "All"}</td>
                  <td className="px-4 py-3 text-gray-600">{rule.channelName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <EnabledBadge enabled={rule.enabled} />
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
