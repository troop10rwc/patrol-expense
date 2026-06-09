// Minimal CSV utilities for the Google Sheet import. No dependencies — the sheet
// is fetched as CSV via the public export endpoint and parsed here.

/**
 * Parse RFC-4180 CSV into rows of string cells. Handles quoted fields (with
 * embedded commas/newlines and `""` escapes), `\r\n`/`\n` line endings, and a
 * leading BOM. Rows are ragged; callers index by column and treat missing
 * cells as "".
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") { /* ignore; handled by the following \n */ }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);

  // Drop trailing fully-empty rows (a trailing newline yields one).
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

/** Pull the document id out of a Google Sheets URL (or a bare id paste). */
export function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  const bare = url.trim();
  return /^[a-zA-Z0-9-_]{20,}$/.test(bare) ? bare : null;
}

/** Public CSV export of a sheet's first tab. */
export function csvExportUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

/** Public XLSX export — the whole workbook (every tab) in one file. */
export function xlsxExportUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
}

/**
 * Parse a currency cell to a number, or `null` if it isn't a number at all.
 * A trailing "%" is a formatting bug in these sheets — the underlying value is a
 * decimal (e.g. "2408%" -> 24.08), so we convert it rather than reject it.
 */
export function parseCurrency(raw: string): number | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  const percent = s.endsWith("%");
  if (percent) s = s.slice(0, -1);
  const cleaned = s.replace(/[$,\s]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}
