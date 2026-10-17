// Fails on an import cycle between our modules (src/, public/ without vendor/): modules form layers, each importing only
// from below. A cycle means half-initialized bindings at startup and modules that can no longer be understood alone.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (e.name === 'vendor' ? [] : files(join(dir, e.name))) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
const graph = new Map([...files('src'), ...files('public')].map(f => [f,
  [...readFileSync(f, 'utf8').matchAll(/^(?:import|export)\s[^;]*?from\s*'(\.[^']+)'|^import\s*'(\.[^']+)'/gm)]
    .map(m => normalize(join(dirname(f), m[1] ?? m[2])))]));

const state = new Map(), path = [], cycles = []; // state: 1 = on the current path, 2 = done
const visit = f => {
  state.set(f, 1); path.push(f);
  for (const g of graph.get(f) ?? []) {
    if (state.get(g) === 1) cycles.push([...path.slice(path.indexOf(g)), g].join(' → '));
    else if (!state.has(g)) visit(g);
  }
  path.pop(); state.set(f, 2);
};
for (const f of graph.keys()) if (!state.has(f)) visit(f);
if (cycles.length) { console.error(`Importzyklen:\n  ${cycles.join('\n  ')}`); process.exit(1); }
