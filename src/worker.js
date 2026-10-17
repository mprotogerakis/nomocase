// NomoCase: JSON API on Cloudflare Workers, data in D1, files in R2. The UI is static (public/) and only talks to /api/*.
// This file: routes, request handling (origin check, session, errors) and the cron entry.
import { appVersion, DB, fail, HttpError, init, json, now, q } from './core.js';
import { deletePasskey, devLogin, giveConsent, legalInfo, listPasskeys, loadUser, logout, me, originOf, passkeyLoginOptions, passkeyLoginVerify, passkeyRegisterOptions, passkeyRegisterVerify, requestLoginLink, sendParticipantLink, updateMe, useLoginLink, withdrawConsent } from './auth.js';
import { addTemplateVersion, createTemplate, deleteTemplate, listTemplates, restoreTemplate, saveAsTemplate } from './templates.js';
import { addComment, addPhase, addSubcase, applyRetention, createCase, dashboard, deleteCase, getCase, getChanges, moveCase, updateCase, updateFields } from './cases.js';
import { addTask, deleteTask, taskAction, updateTask } from './tasks.js';
import { addClaim, addDecision, addTransaction, reverseTransaction, taskMoney } from './finance.js';
import { processRules, toggleRule } from './rules.js';
import { createUploadLink, deleteVersion, download, getUploadLink, revokeUploadLinks, updateDocument, upload, useUploadLink } from './documents.js';
import { acceptInvitation, declineInvitation, getInvitation, invite, peopleOverview, revoke, withdrawInvitation } from './people.js';
import { DAILY_CRON, sendDigests, sendProgress, testMail } from './notify.js';
import { addSigningKey, addTrustedIssuer, assignSignature, claimSignature, mySigningKeys, removeSigningKey, removeTrustedIssuer } from './signatures.js';
import { receiveMail } from './inbox.js';
import { taskForm } from './forms.js';
import { createWorkspace, deleteWorkspace, getBranding, inviteToWorkspace, listWorkspaces, removeMember, renameWorkspace, setBranding, setMemberRole, withdrawWorkspaceInvitation } from './workspaces.js';

// Without consent to the current text only this works: reading it, agreeing or withdrawing, the own status, logging out.
const CONSENT_FREE = new Set([me, logout, giveConsent, withdrawConsent]);

const ROUTES = [
  ['GET', '/api/me', me, true],
  ['GET', '/api/version', () => ({ version: appVersion() }), true],
  ['GET', '/api/legal', legalInfo, true],
  ['POST', '/api/consent', giveConsent],
  ['POST', '/api/consent/withdraw', withdrawConsent],
  ['POST', '/api/invitations/decline', declineInvitation, true],
  ['PATCH', '/api/me', updateMe],
  ['GET', '/api/people', peopleOverview],
  ['GET', '/api/workspaces', listWorkspaces],
  ['POST', '/api/workspaces/:id/issuers', addTrustedIssuer],
  ['DELETE', '/api/workspaces/:id/issuers/:fp', removeTrustedIssuer],
  ['POST', '/api/signatures/claim', claimSignature],
  ['POST', '/api/signatures/assign', assignSignature],
  ['GET', '/api/me/signing-keys', mySigningKeys],
  ['POST', '/api/me/test-mail', testMail],
  ['POST', '/api/me/signing-keys', addSigningKey],
  ['DELETE', '/api/me/signing-keys/:fp', removeSigningKey],
  ['POST', '/api/workspaces', createWorkspace],
  ['PATCH', '/api/workspaces/:id', renameWorkspace],
  ['GET', '/api/workspaces/:id/branding', getBranding],
  ['PUT', '/api/workspaces/:id/branding', setBranding],
  ['DELETE', '/api/workspaces/:id', deleteWorkspace],
  ['POST', '/api/workspaces/:id/invitations', inviteToWorkspace],
  ['DELETE', '/api/workspaces/:id/invitations/:email', withdrawWorkspaceInvitation],
  ['PATCH', '/api/workspaces/:id/members/:userId', setMemberRole],
  ['DELETE', '/api/workspaces/:id/members/:userId', removeMember],
  ['GET', '/api/changes', getChanges],
  ['POST', '/api/dev-login', devLogin, true],
  ['POST', '/api/logout', logout, true],
  ['GET', '/api/invitations/:token', getInvitation, true],
  ['POST', '/api/invitations/accept', acceptInvitation, true],
  ['POST', '/api/login-link', useLoginLink, true],
  ['POST', '/api/login-link/request', requestLoginLink, true],
  ['POST', '/api/passkeys/login/options', passkeyLoginOptions, true],
  ['POST', '/api/passkeys/login/verify', passkeyLoginVerify, true],
  ['GET', '/api/passkeys', listPasskeys],
  ['POST', '/api/passkeys/register/options', passkeyRegisterOptions],
  ['POST', '/api/passkeys/register/verify', passkeyRegisterVerify],
  ['DELETE', '/api/passkeys/:id', deletePasskey],
  ['GET', '/api/dashboard', dashboard],
  ['GET', '/api/templates', listTemplates],
  ['POST', '/api/templates', createTemplate],
  ['POST', '/api/templates/:id/versions', addTemplateVersion],
  ['DELETE', '/api/templates/:id', deleteTemplate],
  ['POST', '/api/templates/:id/restore', restoreTemplate],
  ['POST', '/api/cases', createCase],
  ['GET', '/api/cases/:id', getCase],
  ['PATCH', '/api/cases/:id', updateCase],
  ['PATCH', '/api/cases/:id/fields', updateFields],
  ['PATCH', '/api/cases/:id/rules/:ruleId', toggleRule],
  ['POST', '/api/cases/:id/template', saveAsTemplate],
  ['POST', '/api/cases/:id/subcases', addSubcase],
  ['POST', '/api/cases/:id/move', moveCase],
  ['DELETE', '/api/cases/:id', deleteCase],
  ['POST', '/api/cases/:id/phases', addPhase],
  ['POST', '/api/cases/:id/tasks', addTask],
  ['POST', '/api/cases/:id/comments', addComment],
  ['POST', '/api/cases/:id/documents', upload],
  ['POST', '/api/cases/:id/invitations', invite],
  ['DELETE', '/api/cases/:id/participants/:userId', revoke],
  ['DELETE', '/api/cases/:id/invitations/:email', withdrawInvitation],
  ['DELETE', '/api/document-versions/:id', deleteVersion],
  ['POST', '/api/cases/:id/participants/:userId/login-link', sendParticipantLink],
  ['PATCH', '/api/tasks/:id', updateTask],
  ['DELETE', '/api/tasks/:id', deleteTask],
  ['POST', '/api/tasks/:id/action', taskAction],
  ['GET', '/api/tasks/:id/form', taskForm],
  ['POST', '/api/tasks/:id/money', taskMoney],
  ['POST', '/api/tasks/:id/upload-links', createUploadLink],
  ['DELETE', '/api/tasks/:id/upload-links', revokeUploadLinks],
  ['GET', '/api/upload-links/:token', getUploadLink, true],
  ['POST', '/api/upload-links/:token', useUploadLink, true],
  ['PATCH', '/api/documents/:id', updateDocument],
  ['POST', '/api/cases/:id/claims', addClaim],
  ['POST', '/api/claims/:id/decisions', addDecision],
  ['POST', '/api/claims/:id/transactions', addTransaction],
  ['POST', '/api/transactions/:id/reverse', reverseTransaction],
  ['GET', '/api/files/:id', download],
].map(([method, path, handler, isPublic]) => [method, new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, isPublic]);

export default {
  async fetch(req, env, exec) {
    init(env);
    const url = new URL(req.url);
    // A former domain: permanent redirect to the canonical origin (the #fragment of the old link survives in the browser).
    if ((env.REDIRECT_HOSTS ?? '').split(',').filter(Boolean).includes(url.hostname)) return Response.redirect(`${env.ORIGIN}${url.pathname}${url.search}`, 301);
    const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) return json({ error: 'Nicht gefunden' }, 404);
    const [, re, handler, isPublic] = route;
    try {
      // Writes only from our own pages: browsers send Origin on every POST/PATCH/PUT/DELETE, so a write without one is
      // refused too. (Compared with the request's own origin as well, because wrangler dev rewrites both URL and Origin
      // to the production route.)
      const origin = req.headers.get('origin');
      if (req.method !== 'GET' && origin !== url.origin && origin !== originOf(url)) fail(403, 'Anfrage von fremder Seite');
      const user = await loadUser(req);
      if (!user && !isPublic) fail(401, 'Nicht angemeldet');
      if (user && !isPublic && !user.consented && !CONSENT_FREE.has(handler)) fail(403, 'Bitte stimmen Sie zuerst der Nutzung zu.');
      const body = req.headers.get('content-type')?.includes('application/json') ? await req.json().catch(() => fail(400, 'Ungültiges JSON')) : {};
      const res = await handler({ req, url, user, exec, body: body ?? {}, params: url.pathname.match(re).groups ?? {} });
      if (req.method !== 'GET') await processRules().catch(e => console.error('rules', e.message));
      return res instanceof Response ? res : json(res ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Interner Fehler' }, 500);
    }
  },

  // Mail to a case address (Cloudflare Email Routing → this Worker). A failure bounces with a reason, nothing is lost silently.
  async email(message, env) {
    init(env);
    try {
      await receiveMail(message);
    } catch (e) {
      console.error('mail in failed', e.message);
      message.setReject('Die Mail konnte gerade nicht gespeichert werden. Bitte später erneut senden.');
    }
  },

  async scheduled(controller, env) {
    init(env);
    await processRules(); // catch-up, e.g. after a request that failed midway
    if (controller.cron === DAILY_CRON) {
      await applyRetention();
      await sendDigests();
      // housekeeping: old mail log, expired sessions, login links and passkey challenges
      const t = now();
      await DB.batch([
        q('DELETE FROM mail_log WHERE sent_at < ?', new Date(Date.now() - 3 * 864e5).toISOString()),
        q('DELETE FROM sessions WHERE expires_at < ?', t),
        q('DELETE FROM login_links WHERE expires_at < ?', t),
        q('DELETE FROM challenges WHERE expires_at < ?', t),
      ]);
    } else {
      await sendProgress();
    }
  },
};
