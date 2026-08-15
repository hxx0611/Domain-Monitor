import type { RuleView } from "@/lib/notifications/actions";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";
import { eventTypeLabel } from "@/lib/i18n/display";
import { EnabledBadge } from "./badges";

/**
 * Notification rules table (server component, pure display). Filters are
 * shown friendly: null source / event type / domain render as "All".
 */
export function RulesTable({ rules, dict }: { rules: RuleView[]; dict: Dictionary }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
        {lookup(dict, "notifications.rulesTitle")}
      </h2>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">
            {lookup(dict, "notifications.rulesEmpty.title")}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {lookup(dict, "notifications.rulesEmpty.hint")}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.rulesCol.source")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.rulesCol.eventType")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.rulesCol.domain")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.rulesCol.channel")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.rulesCol.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {rule.source
                      ? lookup(dict, `source.${rule.source}`)
                      : lookup(dict, "common.all")}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {rule.eventType
                      ? eventTypeLabel(rule.eventType, dict)
                      : lookup(dict, "common.all")}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {rule.hostname ?? lookup(dict, "common.all")}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{rule.channelName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <EnabledBadge enabled={rule.enabled} dict={dict} />
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
