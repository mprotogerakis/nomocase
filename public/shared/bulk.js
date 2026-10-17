// Many cases at once: a table pasted from a spreadsheet (tab-, semicolon- or comma-separated, first line = column names).
// Columns: "Titel" (optional: otherwise template name – first value), "E-Mail" (invited into a chosen role), and the
// template's Angaben by label or key. Dates may be written 31.12.2026 or 2026-12-31.
// ponytail: no quoted cells (Excel copies with tabs and without quotes); add a CSV parser if exports need it.

const TITLE = ['titel', 'title', 'vorgang'];
const EMAIL = ['e-mail', 'email', 'mail'];
const norm = s => s.trim().toLowerCase();
const isoDate = s => {
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  return de ? `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}` : s;
};

// → { columns, unknown, rows: [{ line, title, email, fields, problems }] }
export function parseTable(text, def, templateName = '') {
  const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { columns: [], unknown: [], rows: [] };
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const columns = lines[0].split(sep).map(h => {
    const n = norm(h);
    if (TITLE.includes(n)) return { header: h.trim(), kind: 'title' };
    if (EMAIL.includes(n)) return { header: h.trim(), kind: 'email' };
    const f = def.fields.find(x => norm(x.label) === n || norm(x.key) === n);
    return f ? { header: h.trim(), kind: 'field', field: f } : { header: h.trim(), kind: 'unknown' };
  });
  const rows = lines.slice(1).map((l, i) => {
    const cells = l.split(sep).map(c => c.trim());
    const row = { line: i + 2, title: '', email: '', fields: {}, problems: [] };
    columns.forEach((c, j) => {
      const v = cells[j] ?? '';
      if (c.kind === 'title') row.title = v;
      if (c.kind === 'email') row.email = v.toLowerCase();
      if (c.kind === 'field' && v) {
        row.fields[c.field.key] = c.field.type === 'date' ? isoDate(v) : v;
        if (c.field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(row.fields[c.field.key])) {
          delete row.fields[c.field.key];
          row.problems.push(`${c.field.label}: Datum ungültig`);
        }
      }
    });
    if (!row.title) {
      const first = columns.find(c => c.kind === 'field' && c.field.type !== 'date' && row.fields[c.field.key]); // e.g. the name
      row.title = [templateName, first && row.fields[first.field.key]].filter(Boolean).join(' – ');
    }
    if (!row.title) row.problems.push('Titel fehlt');
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) row.problems.push('E-Mail ungültig');
    if (cells.length > columns.length && cells.slice(columns.length).some(Boolean)) row.problems.push('mehr Zellen als Spalten');
    return row;
  });
  return { columns, unknown: columns.filter(c => c.kind === 'unknown').map(c => c.header), rows };
}
