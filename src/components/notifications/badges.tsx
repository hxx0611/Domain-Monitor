import type { DeliveryStatus } from "@/lib/notifications/types";

/** Enabled/Disabled pill, mirroring the status badge style elsewhere. */
export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
      <span className="size-1.5 rounded-full bg-green-500" />
      Enabled
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
      <span className="size-1.5 rounded-full bg-gray-400" />
      Disabled
    </span>
  );
}

/** Delivery status pill: distinct colors per state, mirroring existing badges. */
export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const config: Record<DeliveryStatus, { label: string; className: string; dot: string }> = {
    pending: {
      label: "Pending",
      className: "bg-gray-100 text-gray-600",
      dot: "bg-gray-400",
    },
    sending: {
      label: "Sending",
      className: "bg-blue-50 text-blue-700",
      dot: "bg-blue-500",
    },
    sent: {
      label: "Sent",
      className: "bg-green-50 text-green-700",
      dot: "bg-green-500",
    },
    failed: {
      label: "Failed",
      className: "bg-red-50 text-red-700",
      dot: "bg-red-500",
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
