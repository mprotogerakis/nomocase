// Assessments on a scale the template defines – grades, points, pass/fail – and how several of them combine.
// Pure functions shared by the Worker (which decides) and the UI (which shows). Arithmetic runs in whole steps of
// the scale, so 1,7 and 2,3 never turn into 1.9999.
//
// scale:     { label, range: [from, to], step, extra?: [values], pass: { min?, max? }, verdicts?: [pass, fail], hint? }
//        or  { label, options: [{ value, label }], pass: { min?, max? }, verdicts?, hint? }
// aggregate: { key, label, scale, from: [step keys], method?: mean|min|max|sum, round?: truncate|half_up,
//              fail_value?, field?, note? }

const decimals = scale => (String(scale.step ?? 1).split('.')[1] ?? '').length;
const unit = scale => 10 ** decimals(scale);
const units = (scale, v) => Math.round(v * unit(scale));

// A valid value of the scale, or null. Accepts "1,7" and "1.7"; nothing finer than the step.
export function parseScore(scale, input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (scale.options) return scale.options.some(o => o.value === v) ? v : null;
  if (Math.abs(v * unit(scale) - units(scale, v)) > 1e-9) return null;
  const [from, to] = scale.range.map(n => units(scale, n));
  const x = units(scale, v), step = units(scale, scale.step ?? 1);
  const onScale = x >= from && x <= to && (x - from) % step === 0;
  return onScale || (scale.extra ?? []).some(e => units(scale, e) === x) ? v : null;
}

export const passes = (scale, v) => (scale.pass?.min === undefined || v >= scale.pass.min) && (scale.pass?.max === undefined || v <= scale.pass.max);
export const verdict = (scale, v) => (scale.verdicts ?? ['Bestanden', 'Nicht bestanden'])[passes(scale, v) ? 0 : 1];
export const formatScore = (scale, v) => (scale.options
  ? scale.options.find(o => o.value === v)?.label ?? String(v)
  : Number(v).toFixed(decimals(scale)).replace('.', ','));

// Combined value of several assessments: { value, raw, passed }. `raw` is the computed value; `value` is what counts
// (fail_value when the computed value does not pass, if the template defines one).
export function aggregate(agg, scale, values) {
  if (!values.length) return null;
  const xs = values.map(v => units(scale, v));
  const total = xs.reduce((a, b) => a + b, 0);
  const x = { mean: total / xs.length, min: Math.min(...xs), max: Math.max(...xs), sum: total }[agg.method ?? 'mean'];
  const step = units(scale, scale.step ?? 1);
  const raw = (agg.round === 'truncate' ? Math.trunc(x / step) : Math.round(x / step)) * step / unit(scale);
  const passed = passes(scale, raw);
  return { value: passed || agg.fail_value === undefined ? raw : agg.fail_value, raw, passed };
}

// Template check (used by checkDef): returns an error text or null.
export function scaleProblem(scale) {
  if (!scale || typeof scale.label !== 'string') return 'braucht label';
  const nums = a => Array.isArray(a) && a.every(n => typeof n === 'number');
  if (scale.options) {
    if (!Array.isArray(scale.options) || !scale.options.length || !scale.options.every(o => typeof o.value === 'number' && typeof o.label === 'string')) return 'options: Liste von { value, label }';
  } else if (!(nums(scale.range) && scale.range.length === 2 && scale.range[0] < scale.range[1] && scale.step > 0 && (scale.extra === undefined || nums(scale.extra)))) {
    return 'braucht range [von, bis] und step > 0 (optional extra) oder options';
  }
  if (!scale.pass || (typeof scale.pass.min !== 'number' && typeof scale.pass.max !== 'number')) return 'braucht pass mit min und/oder max';
  return null;
}
