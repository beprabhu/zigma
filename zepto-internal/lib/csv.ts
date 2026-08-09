// Minimal RFC-4180-ish CSV parser (handles quoted fields, escaped quotes, CRLF).

export type CsvRecord = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  records: CsvRecord[];
}

export function parseCSV(text: string): ParsedCsv {
  // Strip UTF-8 BOM — Excel exports prepend it, which corrupts the first header
  // ("﻿Title" !== "Title") and silently breaks column detection.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop fully empty trailing rows
  while (rows.length && rows[rows.length - 1].every((f) => f.trim() === '')) rows.pop();
  if (!rows.length) return { headers: [], records: [] };
  // Records are keyed by header NAME, so an empty header (trailing commas in the header row)
  // or a duplicate name cannot address a column of its own — later writes just overwrite
  // earlier ones. Surface each usable name once: empties dropped, duplicates collapsed to the
  // one entry whose values (by the overwrite rule) come from the LAST column with that name.
  // Consumers map over headers as React keys and checkbox ids, so uniqueness is load-bearing.
  const rawHeaders = rows[0].map((h) => h.trim());
  const headers = [...new Set(rawHeaders.filter(Boolean))];
  const records = rows.slice(1).map((r) => {
    const obj: CsvRecord = {};
    rawHeaders.forEach((h, idx) => { if (h) obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, records };
}

// Auto-detect helpers ------------------------------------------------------
const URL_RE = /^https?:\/\/\S+/i;

// Columns where most non-empty values look like image URLs.
export function detectImageColumns(headers: string[], records: CsvRecord[]): string[] {
  return headers.filter((h) => {
    const vals = records.map((r) => r[h]).filter((v) => v);
    if (!vals.length) return false;
    const urlish = vals.filter((v) => URL_RE.test(v)).length;
    return urlish / vals.length >= 0.6;
  });
}

export function detectTitleColumn(headers: string[], imageCols: string[]): string {
  const candidates = headers.filter((h) => !imageCols.includes(h));
  // Exact title/name headers first, so e.g. "product_id" never wins over "title".
  return (
    candidates.find((h) => /^(product[ _-]?)?(title|name)$/i.test(h.trim())) ||
    candidates.find((h) => /title|name/i.test(h)) ||
    candidates.find((h) => /product/i.test(h)) ||
    ''
  );
}

export function detectOfferColumn(headers: string[], imageCols: string[]): string {
  const candidates = headers.filter((h) => !imageCols.includes(h));
  return candidates.find((h) => /offer|discount|deal|promo/i.test(h)) || '';
}
