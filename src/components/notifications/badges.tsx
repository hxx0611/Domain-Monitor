import type { Dictionary } from "@/lib/i18n/en";
import { lookup } from "@/lib/i18n/display";
import type { DeliveryStatus } from "@/lib/notifications/types";

/** Enabled/Disabled pill, mirroring the status badge style elsewhere. */
export function EnabledBadge({ enabled, dict }: { enabled: boolean; dict: Dictionary }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
      <span className="size-1.5 rounded-full bg-green-500" />
      {lookup(dict, "status.enabled")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
      <span className="size-1.5 rounded-full bg-gray-400" />
      {lookup(dict, "status.disabled")}
    </span>
  );
}

/** Delivery status pill: distinct colors per state, mirroring existing badges. */
export function DeliveryStatusBadge({
  status,
  dict,
}: {
  status: DeliveryStatus;
  dict: Dictionary;
}) {
  const config: Record<DeliveryStatus, { key: string; className: string; dot: string }> = {
    pending: {
      key: "status.pending",
      className: "bg-gray-100 text-gray-600",
      dot: "bg-gray-400",
    },
    sending: {
      key: "status.sending",
      className: "bg-blue-50 text-blue-700",
      dot: "bg-blue-500",
    },
    sent: {
      key: "status.sent",
      className: "bg-green-50 text-green-700",
      dot: "bg-green-500",
    },
    failed: {
      key: "status.failed",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
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
