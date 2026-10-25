// Publishes the templates in templates/*.json as new versions where they differ from the latest one in D1.
// Each file is checked with the server's own checkDef first. A latest version saved through the UI (created_by set)
// is only replaced with --force, so nobody's edits are overwritten silently. Running cases are never touched.
// Usage: node scripts/templates.mjs [--remote] [--force] [--dry-run]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDef } from '../src/templates.js';

const args = process.argv.slice(2);
const remote = args.includes('--remote'), force = args.includes('--force'), dry = args.includes('--dry-run');
// NOMOCASE_STATE: another local state than .wrangler/state (the test runner prepares its own)
const where = remote ? ['--remote'] : ['--local', ...(process.env.NOMOCASE_STATE ? ['--persist-to', process.env.NOMOCASE_STATE] : [])];
const wrangler = a => execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', ...where, ...a],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });
const query = sql => JSON.parse(wrangler(['--json', '--command', sql]))[0].results;
const lit = v => (v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
// Same content regardless of key order.
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

const files = readdirSync(new URL('../templates/', import.meta.url)).filter(f => f.endsWith('.json')).sort();
const templates = files.map(f => ({ file: f, ...JSON.parse(readFileSync(new URL(`../templates/${f}`, import.meta.url), 'utf8')) }));
for (const t of templates) {
  try { checkDef(structuredClone(t.definition)); } catch (e) { throw new Error(`${t.file}: ${e.message}`); }
}
const latest = new Map(query(`SELECT t.id, t.name, v.version, v.definition, v.created_by FROM templates t
  JOIN template_versions v ON v.template_id = t.id AND v.version = (SELECT MAX(version) FROM template_versions WHERE template_id = t.id)
  WHERE t.id IN (${templates.map(t => lit(t.id)).join(', ')})`).map(r => [r.id, r])); // only ours: a local DB holds many test templates

const sql = [], now = new Date().toISOString();
let refused = 0;
for (const t of templates) {
  const cur = latest.get(t.id);
  if (cur && canon(JSON.parse(cur.definition)) === canon(t.definition) && cur.name === t.name) { console.log(`= ${t.file}: unverändert (v${cur.version})`); continue; }
  if (cur?.created_by && !force) { console.log(`! ${t.file}: v${cur.version} wurde über die Oberfläche gespeichert – mit --force ersetzen`); refused++; continue; }
  const version = (cur?.version ?? 0) + 1;
  sql.push(`INSERT INTO templates (id, workspace_id, name) VALUES (${lit(t.id)}, ${lit(t.workspace)}, ${lit(t.name)})
    ON CONFLICT (id) DO UPDATE SET name = excluded.name;`,
    `INSERT INTO template_versions (template_id, version, definition, created_at) VALUES (${lit(t.id)}, ${version}, ${lit(JSON.stringify(t.definition))}, ${lit(now)});`);
  console.log(`+ ${t.file}: wird v${version}`);
}
if (sql.length && !dry) {
  const file = join(mkdtempSync(join(tmpdir(), 'nomocase-templates-')), 'publish.sql');
  writeFileSync(file, sql.join('\n'));
  wrangler(['--file', file]); // remote imports print progress text, not JSON
  console.log(`${sql.length / 2} Vorlage(n) veröffentlicht (${remote ? 'remote' : 'lokal'}).`);
}
process.exit(refused ? 1 : 0);
