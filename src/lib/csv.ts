// Minimal RFC-4180 CSV serializer (no dependency). Quotes fields containing comma, quote,
// or newline; doubles inner quotes.
type Cell = string | number | boolean | null | undefined;

function escape(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  const s = String(cell);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  return lines.join("\r\n");
}
