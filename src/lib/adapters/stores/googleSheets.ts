import { parseCsv } from "@/lib/csv";
import { applyMapping, rowToColumns, type FieldMapping, type MappedOrder } from "@/lib/ingest/fieldMapping";
import { AdapterError, type FetchLike } from "./http";

/**
 * Google Sheets order source (section 12.1): polling a sheet with a fixed column mapping, the
 * usual setup for landing-page forms. Uses the documented CSV export of a sheet shared as
 * "anyone with the link can view": https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}
 * (no OAuth needed; the owner can switch to the Sheets API later behind the same function).
 */
export const SHEET_DEFAULT_MAPPING: FieldMapping = {
  createdAt: "columns.A",
  customerName: "columns.B",
  phone: "columns.C",
  wilaya: "columns.D",
  commune: "columns.E",
  address: "columns.F",
  itemName: "columns.G",
  itemVariant: "columns.H",
  itemQty: "columns.I",
  total: "columns.J",
  deliveryType: "columns.K",
  note: "columns.L",
};

export function sheetCsvUrl(sheetId: string, gid = "0"): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

/** Extract the sheet id from a full Google Sheets URL or return the id as-is. */
export function parseSheetRef(input: string): { sheetId: string; gid: string } {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gid = input.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
  return { sheetId: m?.[1] ?? input.trim(), gid };
}

export async function fetchSheetRows(sheetId: string, gid: string, fetchImpl: FetchLike = fetch): Promise<string[][]> {
  const res = await fetchImpl(sheetCsvUrl(sheetId, gid), { redirect: "follow" });
  if (!res.ok) throw new AdapterError("google_sheet", `Sheet not readable (HTTP ${res.status}). Share it as "anyone with the link can view".`, res.status);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) throw new AdapterError("google_sheet", "Sheet is not public (got an HTML login page).");
  return parseCsv(text, ",");
}

/**
 * Rows after `lastRow` (1-based sheet row numbers, header = row 1) mapped to orders. The external
 * id is the sheet row number so re-polling is idempotent.
 */
export function mapSheetRows(rows: string[][], mapping: FieldMapping | null | undefined, lastRow: number, hasHeader = true): Array<{ rowNumber: number; mapped: MappedOrder }> {
  const out: Array<{ rowNumber: number; mapped: MappedOrder }> = [];
  const m = { ...SHEET_DEFAULT_MAPPING, ...(mapping ?? {}) };
  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    if (hasHeader && rowNumber === 1) return;
    if (rowNumber <= lastRow) return;
    const mapped = applyMapping(rowToColumns(row), m);
    if (!mapped.phone) return;
    mapped.externalId = `row-${rowNumber}`;
    out.push({ rowNumber, mapped });
  });
  return out;
}
