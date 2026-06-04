// Turn a raw domain into a readable brand-ish title so registry cards don't show
// the domain three times. Best-effort: strips protocol/www and trailing TLD labels,
// then title-cases the registrable name. Not a brand database — just better than
// "stackoverflow.com" repeated as title, subtitle, and description.

const TLD_TAILS = new Set([
  "com", "org", "net", "io", "co", "ai", "app", "dev", "gov", "edu",
  "xyz", "so", "sh", "me", "us", "uk", "to", "gg", "tv", "fm",
]);

export function humanizeDomain(domain: string): string {
  if (!domain) return "";
  const host = domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
  const labels = host.split(".").filter(Boolean);
  if (labels.length === 0) return host;
  // drop trailing TLD labels (handles co.uk-style 2-part tails)
  let end = labels.length - 1;
  while (end > 0 && TLD_TAILS.has(labels[end])) end--;
  const core = labels[end] || labels[0];
  return core.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
