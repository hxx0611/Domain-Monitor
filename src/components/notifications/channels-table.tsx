import type { ChannelView } from "@/lib/notifications/actions";
import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";
import { EnabledBadge } from "./badges";
import { AddChannelButton, ChannelToggleButton, EditChannelButton } from "./channel-form";
import { DeleteButton } from "./delete-button";
import { TestNotificationButton } from "./test-notification-button";

/**
 * Map the (English) config field labels produced by the actions layer to
 * dictionary keys. The actions layer emits stable English labels; the UI
 * translates them here — the actions/repository contract is untouched.
 */
const FIELD_LABEL_KEYS: Record<string, string> = {
  To: "notifications.field.to",
  From: "notifications.field.from",
  Endpoint: "notifications.field.endpoint",
  "API key ref": "notifications.field.apiKeyRef",
  URL: "notifications.field.url",
  "Secret ref": "notifications.field.secretRef",
  "Chat ID": "notifications.field.chatId",
  "Legacy token": "notifications.field.legacyToken",
  Language: "notifications.field.language",
  Timezone: "notifications.field.timezone",
};

/**
 * Notification channels table (server component, pure display).
 *
 * Config cells show only non-sensitive fields: for email, to/from/endpoint
 * plus the API key REF name; for webhook, the URL plus the secret REF name.
 * Environment variable values are never read or rendered here.
 */
export function ChannelsTable({ channels, dict }: { channels: ChannelView[]; dict: Dictionary }) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          {lookup(dict, "notifications.channelsTitle")}
        </h2>
        <AddChannelButton dict={dict} />
      </div>

      {channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">
            {lookup(dict, "notifications.channelsEmpty.title")}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {lookup(dict, "notifications.channelsEmpty.hint")}
          </p>
          <div className="mt-4 flex justify-center">
            <AddChannelButton dict={dict} />
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.channelsCol.type")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.channelsCol.name")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.channelsCol.config")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.channelsCol.status")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {lookup(dict, "notifications.channelsCol.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        channel.type === "email"
                          ? "bg-blue-50 text-blue-700"
                          : channel.type === "telegram"
                            ? "bg-green-50 text-green-700"
                            : "bg-purple-50 text-purple-700"
                      }`}
                    >
                      {channel.type === "email"
                        ? lookup(dict, "notifications.channelEmail")
                        : channel.type === "telegram"
                          ? lookup(dict, "notifications.channelTelegram")
                          : lookup(dict, "notifications.channelWebhook")}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{channel.name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {channel.configInvalid ? (
                      <span className="text-gray-400">
                        {lookup(dict, "notifications.invalidConfig")}
                      </span>
                    ) : channel.configFields.length > 0 ? (
                      <ul className="space-y-0.5">
                        {channel.configFields.map((field) => (
                          <li key={field.label} className="break-all">
                            <span className="text-gray-400">
                              {lookup(
                                dict,
                                FIELD_LABEL_KEYS[field.label] ??
                                  `notifications.field.${field.label}`,
                              )}
                              :
                            </span>{" "}
                            <span className="font-mono text-xs">{field.value}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <EnabledBadge enabled={channel.enabled} dict={dict} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <EditChannelButton channel={channel} dict={dict} />
                      <ChannelToggleButton channel={channel} dict={dict} />
                      <DeleteButton dict={dict} kind="channel" id={channel.id} />
                      <TestNotificationButton
                        channelId={channel.id}
                        labels={{
                          send: lookup(dict, "notifications.testNotification.send"),
                          sending: lookup(dict, "notifications.testNotification.sending"),
                          success: lookup(dict, "notifications.testNotification.success"),
                        }}
                      />
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
