// Runs the test suites (npm test). Each suite that needs a server gets its own: a copy of a freshly prepared local state
// (migrations, seed, templates) and its own wrangler dev on a free port. So runs side by side (two people, two agents)
// never see each other's data, and no suite has to clean up after another one or after earlier runs.
// Usage: node test/run.mjs [suite …]   (default: all, in this order)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALL = ['validate', 'assess', 'pdfsig', 'forms', 'bulk', 'mime', 'session', 'notify', 'invite', 'migrations', 'smoke', 'praxisprojekt', 'ui', 'passkey'];
const SERVER = ['smoke', 'praxisprojekt', 'ui', 'passkey'];
const suites = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const unknown = suites.filter(s => !ALL.includes(s));
if (unknown.length) { console.error(`Unbekannte Suite: ${unknown.join(', ')} (bekannt: ${ALL.join(', ')})`); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'nomocase-test-'));
const servers = new Set();
process.on('exit', () => { for (const s of servers) s.stop(); rmSync(tmp, { recursive: true, force: true }); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const quiet = (cmd, args, env = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...env } });
let prepared;
const prepare = () => {
  const state = join(tmp, 'prepared'), local = ['--local', '--persist-to', state];
  quiet('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nomocase', ...local]);
  quiet('npx', ['wrangler', 'd1', 'execute', 'nomocase', ...local, '--file', 'seed.sql']);
  quiet('node', ['scripts/templates.mjs'], { NOMOCASE_STATE: state });
  return state;
};

const freePort = () => new Promise(resolve => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(name) {
  const state = join(tmp, name), log = join(tmp, `${name}.log`);
  cpSync(prepared ??= prepare(), state, { recursive: true });
  const [port, inspector] = [await freePort(), await freePort()];
  const base = `http://localhost:${port}`;
  // own process group: stopping it ends wrangler and its workerd together
  const dev = spawn('npx', ['wrangler', 'dev', '--port', port, '--inspector-port', inspector, '--test-scheduled', '--persist-to', state,
    '--var', `ORIGIN:${base}`, '--show-interactive-dev-session=false'], { stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')], detached: true });
  const server = { base, state, log, stop: () => { try { process.kill(-dev.pid); } catch {} servers.delete(server); } };
  servers.add(server);
  for (let i = 0; i < 300; i++) {
    if (await fetch(`${base}/api/me`).then(r => r.ok, () => false)) return server;
    if (dev.exitCode != null) break;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`wrangler dev für ${name} startet nicht:\n${readFileSync(log, 'utf8').slice(-2000)}`);
}

for (const name of suites) {
  const server = SERVER.includes(name) ? await startServer(name) : null;
  const env = server ? { ...process.env, BASE: server.base, NOMOCASE_STATE: server.state } : process.env;
  const { status } = spawnSync('node', [`test/${name}.mjs`], { stdio: 'inherit', env });
  if (status !== 0) {
    if (server) console.error(`\n--- wrangler dev (${name}), letzte Zeilen ---\n${readFileSync(server.log, 'utf8').slice(-3000)}`);
    console.error(`FAIL – ${name}`);
    process.exit(1);
  }
  server?.stop();
}
