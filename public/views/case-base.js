// What the case page (case.js) and its sections (tasks.js, documents.js, finance.js) share. They all import it from
// here, so no section needs the page, nor a sibling that needs it back (no import cycles: scripts/cycles.mjs).
import { STAFF } from '../shared/vocab.js';
import { cur } from '../state.js';

export const caseApi = path => `/cases/${cur.case.id}${path}`;

export const roleLabel = k => cur?.definition.roles.find(r => r.key === k)?.label ?? k ?? '–';

export const docTypeLabel = k => cur?.definition.document_types.find(t => t.key === k)?.label ?? '';

export const guestRoles = d => d.definition.roles.filter(r => !STAFF.includes(r.access));

// A role is a seat in the case. People are invited into a role; tasks and sharing go to the role,
// so everyone holding it sees the same and one of them is enough to do a task.
export const active = p => !p.revoked_at && !(p.expires_at && p.expires_at < new Date().toISOString());

export const holders = (d, role) => d.participants.filter(p => p.role === role && active(p)).map(p => p.name);

export const canWork = (t, d) => t.status === 'open' && !t.blocked && (d.me.staff || (t.role === d.me.role && d.me.access !== 'guest_viewer'));

export const taskTitle = (id, d) => (id ? d.tasks.find(t => t.id === id)?.title : null);

// While an external has an open task for this document type, the task is the one way to hand in a new version.
export const openTaskFor = (doc, d) => !d.me.staff && d.tasks.some(t => t.doc_type && t.doc_type === doc.doc_type && canWork(t, d));
