/** Calendar dates are plain "YYYY-MM-DD" strings in the store's time zone, so day counts never drift by a time zone. */

export function storeTimeZone(): string {
  return process.env.STORE_TIMEZONE?.trim() || "America/Los_Angeles";
}

/** Today's date in the store's time zone, as YYYY-MM-DD. */
export function todayInStore(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: storeTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "Friday, October 31, 2026": the only date format customers see, so the fact checker can match it exactly. */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}
