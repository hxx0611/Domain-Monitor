const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Format a date as e.g. "Aug 11, 2026". */
export function formatDate(date: Date): string {
  return dateFormatter.format(date);
}
