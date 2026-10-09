/**
 * Minimal RFC 4180 CSV parser / writer (no dependency). Handles quoted fields, escaped quotes,
 * CRLF, a UTF-8 BOM and `;` separated files exported by Excel in French locales.
 */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<"," | ";" | "\t", number>;
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch as "," | ";" | "\t"]++;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as "," | ";" | "\t";
}

export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse with a header row → array of objects keyed by header. */
export function parseCsvObjects(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function escapeCell(v: unknown, sep: string): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  // neutralize spreadsheet formula injection
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /["\n\r]/.test(safe) || safe.includes(sep) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: unknown[][], sep = ","): string {
  return "﻿" + rows.map((r) => r.map((c) => escapeCell(c, sep)).join(sep)).join("\r\n") + "\r\n";
}

/**
 * Excel export without a dependency: SpreadsheetML 2003 (.xls) that Excel and LibreOffice open
 * natively, with proper text/number cells (phones stay text, amounts stay numbers).
 */
export function toSpreadsheetXml(sheetName: string, rows: unknown[][]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cell = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
    if (v instanceof Date) return `<Cell><Data ss:Type="String">${esc(v.toISOString())}</Data></Cell>`;
    return `<Cell><Data ss:Type="String">${esc(v === null || v === undefined ? "" : String(v))}</Data></Cell>`;
  };
  const body = rows.map((r) => `<Row>${r.map(cell).join("")}</Row>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${esc(sheetName.slice(0, 31))}"><Table>
${body}
</Table></Worksheet></Workbook>`;
}
