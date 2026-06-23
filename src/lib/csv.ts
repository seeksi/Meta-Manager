// Minimal RFC-4180 CSV serializer (no dependency). Quotes fields containing comma, quote,
// or newline; doubles inner quotes. Also neutralizes spreadsheet formula injection.
type Cell = string | number | boolean | null | undefined;

function escape(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  let s = String(cell);
  // Formula-injection guard: a cell starting with = + - @ (or tab/CR) can execute when opened
  // in Excel/Sheets. Exports include untrusted text (competitor copy, lead/AI fields), so prefix
  // such cells with a single quote to force text interpretation.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  return lines.join("\r\n");
}
