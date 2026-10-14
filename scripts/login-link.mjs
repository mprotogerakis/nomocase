// One-time login link (valid 24 h) for an existing user: first login of the owner, or recovery after losing all passkeys.
// Usage: npm run login-link -- <email> [--remote] [--base URL]   (base defaults to localhost / the production origin)
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values, positionals: [email] } = parseArgs({
  allowPositionals: true,
  options: { remote: { type: 'boolean', default: false }, base: { type: 'string' } },
});
if (!email) {
  console.error('Usage: npm run login-link -- <email> [--remote] [--base URL]');
  process.exit(1);
}

const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const sqlEmail = email.trim().toLowerCase().replaceAll("'", "''");
const sql = `INSERT INTO login_links (token_hash, user_id, expires_at)
  SELECT '${hash}', id, '${new Date(Date.now() + 864e5).toISOString()}' FROM users WHERE email = '${sqlEmail}' RETURNING user_id`;
const out = JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'nomocase', values.remote ? '--remote' : '--local', '--json', '--command', sql], { encoding: 'utf8' }));
if (!out[0].results.length) {
  console.error(`Kein Benutzer mit der E-Mail ${email}`);
  process.exit(1);
}
console.log(`${values.base ?? (values.remote ? 'https://nomocase-old.example.org' : 'http://localhost:8787')}/#/login/${token}`);
