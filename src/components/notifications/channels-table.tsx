import type { ChannelView } from "@/lib/notifications/actions";
import { EnabledBadge } from "./badges";

/**
 * Notification channels table (server component, pure display).
 *
 * Config cells show only non-sensitive fields: for email, to/from/endpoint
 * plus the API key REF name; for webhook, the URL plus the secret REF name.
 * Environment variable values are never read or rendered here.
 */
export function ChannelsTable({ channels }: { channels: ChannelView[] }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Notification Channels
      </h2>

      {channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">No channels yet.</p>
          <p className="mt-1 text-sm text-gray-500">
            Notifications are delivered through email or webhook channels.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="px-4 py-3 font-medium">
                  Type
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Config
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
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
                          : "bg-purple-50 text-purple-700"
                      }`}
                    >
                      {channel.type === "email" ? "Email" : "Webhook"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{channel.name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {channel.configInvalid ? (
                      <span className="text-gray-400">Invalid config</span>
                    ) : channel.configFields.length > 0 ? (
                      <ul className="space-y-0.5">
                        {channel.configFields.map((field) => (
                          <li key={field.label} className="break-all">
                            <span className="text-gray-400">{field.label}:</span>{" "}
                            <span className="font-mono text-xs">{field.value}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <EnabledBadge enabled={channel.enabled} />
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
