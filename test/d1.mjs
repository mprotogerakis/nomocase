// D1 on node:sqlite with the real schema (all migrations), for unit tests of code that talks to the database: its SQL
// runs for real. failOn(prefix): batches with a statement starting so fail (D1 gone at that moment). afterRead(re, fn):
// fn runs once, right after the first query matching re – something happening in between, e.g. a withdrawal.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function d1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  let failing = null, hook = null;
  const then = (text, out) => {
    if (hook?.re.test(text)) { const { fn } = hook; hook = null; fn(); }
    return out;
  };
  const statement = (text, args) => ({
    text, args,
    first: async () => then(text, sqlite.prepare(text).get(...args) ?? null),
    all: async () => then(text, { results: sqlite.prepare(text).all(...args) }),
    run: async () => then(text, sqlite.prepare(text).run(...args)),
    raw: async () => then(text, sqlite.prepare(text).all(...args).map(Object.values)),
  });
  const DB = {
    prepare: text => ({ bind: (...args) => statement(text, args) }),
    batch: async stmts => {
      if (failing && stmts.some(st => st.text.startsWith(failing))) throw new Error('D1 unavailable (test)');
      return stmts.map(st => ({ results: sqlite.prepare(st.text).all(...st.args) })); // like D1: not through the statements' own calls
    },
  };
  return { sqlite, DB, failOn: prefix => { failing = prefix; }, afterRead: (re, fn) => { hook = { re, fn }; } };
}
