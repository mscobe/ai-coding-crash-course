// ─── Display formatting ───
// Formatters shared by the analytics pages. Safe on server and client.

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** An amount in cents as US dollars, e.g. 123456 → "$1,234.56". */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * English name for an ISO country code ("DE" → "Germany"). Unknown codes come
 * back as-is; null (no country recorded) is "Unknown".
 */
export function countryName(code: string | null): string {
  if (code === null) return "Unknown";
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
