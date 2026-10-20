// D1 on node:sqlite with the real schema (all migrations), for unit tests of code that talks to the database: its SQL
// runs for real, a batch is one transaction (rolled back as a whole on any error, as on D1), results look like D1's
// (`results`, `meta.changes`). failOn(prefix): statements starting so fail – alone, or the batch they are in (D1 gone at
// that moment). afterRead(re, fn): fn runs once, right after the first query matching re – something happening in
// between, e.g. a withdrawal.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function d1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  let failing = null, hook = null;
  const exec = (text, args) => {
    if (failing && text.startsWith(failing)) throw new Error('D1 unavailable (test)');
    const st = sqlite.prepare(text), results = st.columns().length ? st.all(...args) : (st.run(...args), []);
    return { results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
  };
  const then = (text, out) => {
    if (hook?.re.test(text)) { const { fn } = hook; hook = null; fn(); }
    return out;
  };
  const statement = (text, args) => ({
    text, args,
    first: async () => then(text, exec(text, args).results[0] ?? null),
    all: async () => then(text, exec(text, args)),
    run: async () => then(text, exec(text, args)),
    raw: async () => then(text, exec(text, args).results.map(Object.values)),
  });
  const DB = {
    prepare: text => ({ bind: (...args) => statement(text, args) }),
    batch: async stmts => { // like D1: one transaction, and not through the statements' own calls
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map(st => exec(st.text, st.args));
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { sqlite, DB, failOn: prefix => { failing = prefix; }, afterRead: (re, fn) => { hook = { re, fn }; } };
}
