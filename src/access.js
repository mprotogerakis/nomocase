// Who may see and do what in a case: case context, visibility of events/documents/tasks, workable tasks.
import { arr, fail, now, row, STAFF } from './core.js';

// Workspace owners see every case of their workspace. Everyone else needs an active
// case_participants row. Within a case, staff (case_owner/editor) see everything;
// guests see resources shared with their process role, plus what they created.

export async function caseCtx(user, caseId) {
  const c = await row('SELECT c.*, t.name AS template_name FROM cases c LEFT JOIN templates t ON t.id = c.template_id WHERE c.id = ?', caseId);
  const p = c && await row('SELECT access, role FROM case_participants WHERE case_id = ? AND user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', caseId, user.id, now());
  const wsOwner = c && await row("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'", c.workspace_id, user.id);
  if (!p && !wsOwner) fail(404, 'Vorgang nicht gefunden'); // 404, not 403: don't reveal that the case exists
  const access = wsOwner ? 'case_owner' : p.access;
  return { c, user, def: JSON.parse(c.definition), role: p?.role ?? null, access, staff: STAFF.includes(access), owner: access === 'case_owner' };
}

export const canSee = (ctx, r) => ctx.staff || (r.created_by ?? r.actor_id) === ctx.user.id || arr(r.visible_to).some(v => v === '*' || v === ctx.role);

export const canSeeTask = (ctx, t) => (ctx.role && t.role === ctx.role) || canSee(ctx, t);

export const canWork = (ctx, t) => ctx.staff || (ctx.role && t.role === ctx.role && ctx.access !== 'guest_viewer');

export const taskAudience = t => [...new Set([t.role, ...arr(t.visible_to)].filter(Boolean))];

export const requireWsOwner = async (user, wsId) =>
  (await row("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'", wsId ?? null, user.id)) ?? fail(403, 'Nur für Workspace-Owner');

// Cases the user may open (participant or workspace owner); used to show parents and subcases without leaking titles.
export const ACCESSIBLE = `(EXISTS (SELECT 1 FROM case_participants p WHERE p.case_id = c.id AND p.user_id = ?2 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?3))
  OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = ?2 AND m.role = 'owner'))`;
