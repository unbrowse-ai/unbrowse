export const MONTH_INDEX: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

export function inferCalendarIsoDate(monthLabel: string, dayLabel: string): string | null {
  const day = Number.parseInt(dayLabel.trim(), 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  const year = monthLabel.match(/\b(\d{4})\b/)?.[1];
  if (!year) return null;

  const tokens = monthLabel
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const month = tokens
    .map((token) => MONTH_INDEX[token] ?? MONTH_INDEX[token.slice(0, 3)])
    .find(Boolean);
  if (!month) return null;

  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}
