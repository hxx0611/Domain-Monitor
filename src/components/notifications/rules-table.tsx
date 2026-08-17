import type { ChannelView, RuleView } from "@/lib/notifications/actions";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";
import { eventTypeLabel } from "@/lib/i18n/display";
import { EnabledBadge } from "./badges";
import { AddRuleButton, EditRuleButton, RuleToggleButton, type RuleFormOption } from "./rule-form";
import { DeleteButton } from "./delete-button";

/**
 * Notification rules table (server component, pure display). Filters are
 * shown friendly: null source / event type / domain render as "All".
 * channels/domains are passed through for the add/edit forms.
 */
export function RulesTable({
  rules,
  channels,
  domains,
  dict,
}: {
  rules: RuleView[];
  channels: ChannelView[];
  domains: RuleFormOption[];
  dict: Dictionary;
}) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          {lookup(dict, "notifications.rulesTitle")}
        </h2>
        <AddRuleButton channels={channels} domains={domains} dict={dict} />
      </div>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">
            {lookup(dict, "notifications.rulesEmpty.title")}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {lookup(dict, "notifications.rulesEmpty.hint")}
          </p>
          <div className="mt-4 flex justify-center">
            <AddRuleButton channels={channels} domains={domains} dict={dict} />
          </div>
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
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.rulesCol.actions")}
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
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <EditRuleButton
                        rule={rule}
                        channels={channels}
                        domains={domains}
                        dict={dict}
                      />
                      <RuleToggleButton rule={rule} dict={dict} />
                      <DeleteButton dict={dict} kind="rule" id={rule.id} />
                    </div>
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
