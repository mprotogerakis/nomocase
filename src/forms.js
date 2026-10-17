// Forms of a step (task.form → definition.forms): the server fills in the case's values, the browser makes the PDF.
// Whoever sees the step gets the form – with exactly the values the template put into it, nothing else of the case.
// On upload, a filled-in form is read back and compared with the case's fields (documents.js).
import { fail, isDate } from './core.js';
import { loadTask } from './tasks.js';
import { deDate } from './notify.js';
import { caseFieldItems, fieldNames, fillForm } from '../public/shared/forms.js';
import { readFormFields } from './pdfform.js';
import { branding } from './workspaces.js';

export async function taskForm(rq) {
  const { user, params, rows, time } = rq;
  const { ctx, t } = await loadTask(user, params.id);
  const form = (ctx.def.forms ?? []).find(f => f.key === t.form) ?? fail(404, 'Zu diesem Schritt gehört kein Formular');
  const fields = JSON.parse(ctx.c.fields);
  const people = await rows(`SELECT p.role, u.name, u.email FROM case_participants p JOIN users u ON u.id = p.user_id
    WHERE p.case_id = ? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?) ORDER BY p.created_at`, ctx.c.id, time);
  const lookup = k => {
    if (k === 'case.title') return ctx.c.title;
    const days = k.match(/^date(?:\+(\d+))?$/);
    if (days) return deDate(new Date(Date.now() + Number(days[1] ?? 0) * 864e5).toISOString().slice(0, 10));
    const [kind, key, extra] = k.split('.');
    if (kind === 'field') return isDate(fields[key]) ? deDate(fields[key]) : fields[key] ?? '';
    if (kind === 'role') return people.filter(p => p.role === key).map(p => (extra === 'email' ? p.email : p.name)).join(', ');
    return '';
  };
  return { ...fillForm(form, lookup), ...(await branding(rq, ctx.c.workspace_id)), case_title: ctx.c.title, template: ctx.c.template_name ?? '', created: deDate(time.slice(0, 10)) };
}

// An uploaded PDF that is one of the case's forms (recognised by its field names): what it says about the case's fields.
// Dates are turned back into ISO dates when they can be; empty values are left out.
const same = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();
const isoOf = s => { const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s; };

export async function readUploadedForm(def, pdf) {
  if (!def.forms?.length) return null;
  const read = await readFormFields(pdf);
  if (!read.size) return null;
  const best = def.forms.map(form => {
    const names = fieldNames(form).flatMap(n => Object.values(n));
    return { form, hits: names.filter(n => read.has(n)).length, of: names.length };
  }).filter(x => x.hits >= 2 && x.hits >= x.of * 0.6).sort((a, b) => b.hits - a.hits)[0];
  if (!best) return null;
  const fields = {};
  for (const { name, key } of caseFieldItems(best.form)) {
    const v = read.get(name);
    if (typeof v !== 'string' || !v.trim()) continue;
    fields[key] = def.fields.find(f => f.key === key)?.type === 'date' ? isoOf(v) : v.replace(/\s+/g, ' ').trim();
  }
  return { form: best.form.key, title: best.form.title, fields };
}

// Against the case: values that differ, and values for fields that are still empty (and valid there).
export function compareForm(def, caseFields, read) {
  const label = k => def.fields.find(f => f.key === k)?.label ?? k;
  const entries = Object.entries(read?.fields ?? {});
  return {
    differs: entries.filter(([k, v]) => (caseFields[k] ?? '').trim() && !same(caseFields[k], v)).map(([k]) => label(k)),
    missing: Object.fromEntries(entries.filter(([k, v]) => !(caseFields[k] ?? '').trim()
      && (def.fields.find(f => f.key === k)?.type !== 'date' || isDate(v)))),
  };
}
