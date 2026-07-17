// Minimal RFC-4180-ish CSV parser (handles quoted fields, escaped quotes, CRLF).
window.parseCSV = function parseCSV(text) {
  const rows = [];
  let row = [];
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
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, records };
};

// Auto-detect helpers ------------------------------------------------------
const URL_RE = /^https?:\/\/\S+/i;

// Columns where most non-empty values look like image URLs.
window.detectImageColumns = function detectImageColumns(headers, records) {
  return headers.filter((h) => {
    const vals = records.map((r) => r[h]).filter((v) => v);
    if (!vals.length) return false;
    const urlish = vals.filter((v) => URL_RE.test(v)).length;
    return urlish / vals.length >= 0.6;
  });
};

window.detectTitleColumn = function detectTitleColumn(headers, imageCols) {
  const candidates = headers.filter((h) => !imageCols.includes(h));
  const byName = candidates.find((h) => /title|name|product/i.test(h));
  return byName || '';
};

window.detectOfferColumn = function detectOfferColumn(headers, imageCols) {
  const candidates = headers.filter((h) => !imageCols.includes(h));
  const byName = candidates.find((h) => /offer|discount|deal|promo/i.test(h));
  return byName || '';
};
