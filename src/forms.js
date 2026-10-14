// Forms of a step (task.form → definition.forms): the server fills in the case's values, the browser makes the PDF.
// Whoever sees the step gets the form – with exactly the values the template put into it, nothing else of the case.
import { fail, isDate, now, rows } from './core.js';
import { loadTask } from './tasks.js';
import { deDate } from './notify.js';
import { fillForm } from '../public/shared/forms.js';
import { branding } from './workspaces.js';

export async function taskForm({ user, params }) {
  const { ctx, t } = await loadTask(user, params.id);
  const form = (ctx.def.forms ?? []).find(f => f.key === t.form) ?? fail(404, 'Zu diesem Schritt gehört kein Formular');
  const fields = JSON.parse(ctx.c.fields);
  const people = await rows(`SELECT p.role, u.name, u.email FROM case_participants p JOIN users u ON u.id = p.user_id
    WHERE p.case_id = ? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?) ORDER BY p.created_at`, ctx.c.id, now());
  const lookup = k => {
    if (k === 'case.title') return ctx.c.title;
    const days = k.match(/^date(?:\+(\d+))?$/);
    if (days) return deDate(new Date(Date.now() + Number(days[1] ?? 0) * 864e5).toISOString().slice(0, 10));
    const [kind, key, extra] = k.split('.');
    if (kind === 'field') return isDate(fields[key]) ? deDate(fields[key]) : fields[key] ?? '';
    if (kind === 'role') return people.filter(p => p.role === key).map(p => (extra === 'email' ? p.email : p.name)).join(', ');
    return '';
  };
  return { ...fillForm(form, lookup), ...(await branding(ctx.c.workspace_id)), case_title: ctx.c.title, template: ctx.c.template_name ?? '', created: deDate(now().slice(0, 10)) };
}
