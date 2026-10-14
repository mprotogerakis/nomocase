// Login, own account, invitations, welcome page, login links, upload links for people without an account.
import { STAFF } from '../shared/vocab.js';
import { change, me, on, set, submit } from '../state.js';
import { api, dateTime, go, html, page, reload, show } from '../lib.js';

// Passkeys use the browser's native WebAuthn JSON helpers; the server does the verification.
async function passkeyLogin() {
  const { challenge_id, options } = await api('/passkeys/login/options', { body: {} });
  const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  await api('/passkeys/login/verify', { body: { challenge_id, response: cred.toJSON() } });
}

async function passkeyRegister() {
  const { challenge_id, options } = await api('/passkeys/register/options', { body: {} });
  const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
  await api('/passkeys/register/verify', { body: { challenge_id, response: cred.toJSON() } });
}

// Cancelling the browser dialog is not an error worth a popup.
const webauthn = fn => async (...args) => {
  try { await fn(...args); } catch (e) {
    if (!e.shown && !['NotAllowedError', 'AbortError'].includes(e.name)) alert(`Passkey: ${e.message}`);
  }
};

export function loginView() {
  show(html`<main class="narrow"><h1>NomoCase</h1>
    <button class="block primary" data-on="passkeyLogin">Mit Passkey anmelden</button>
    <details class="add"><summary>Kein Passkey auf diesem Gerät? Anmeldelink per E-Mail</summary>
      <form data-submit="requestLink" class="row">
        <input type="email" name="email" placeholder="Ihre E-Mail-Adresse" required>
        <button>Link schicken</button>
      </form>
    </details>
    <p class="muted small">Noch kein Zugang? Sie erhalten ihn über eine Einladung.</p>
    ${me.dev_users ? html`<h3>Dev-Login (nur lokal)</h3>${me.dev_users.map(u => html`<button class="block" data-on="devLogin" data-email="${u.email}"><b>${u.name}</b> <span class="muted">${u.email}</span></button>`)}` : ''}
  </main>`);
}

on.devLogin = async ({ email }) => { await api('/dev-login', { body: { email } }); go('#/'); };

on.logout = async () => { await api('/logout', { body: {} }); go('#/'); };

on.passkeyLogin = webauthn(async () => { await passkeyLogin(); reload(); });

on.passkeyAdd = webauthn(async () => { await passkeyRegister(); reload(); });

on.passkeyDelete = async ({ id }) => {
  if (!confirm(me.passkeys > 1 ? 'Passkey entfernen?' : 'Das ist Ihr letzter Passkey. Ohne Passkey kommen Sie nach dem Abmelden nicht mehr hinein. Trotzdem entfernen?')) return;
  await api(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  reload();
};

export async function accountView() {
  const passkeys = await api('/passkeys');
  page(html`<main class="narrow"><h1>Konto</h1>
    <dl><dt>Name</dt><dd>${me.user.name}</dd><dt>E-Mail</dt><dd>${me.user.email}</dd></dl>
    <h3>Passkeys</h3>
    ${passkeys.length ? html`<ul class="list">${passkeys.map(p => html`<li>Passkey vom ${dateTime(p.created_at)}
      <span class="muted small">· ${p.last_used_at ? `zuletzt benutzt ${dateTime(p.last_used_at)}` : 'noch nicht benutzt'}</span>
      <button class="link" data-on="passkeyDelete" data-id="${p.id}">entfernen</button></li>`)}</ul>`
      : html`<p class="muted">Noch kein Passkey eingerichtet.</p>`}
    <p><button data-on="passkeyAdd">Passkey hinzufügen</button></p>
    <p class="muted small">Ein Passkey pro Gerät, z. B. Laptop und Handy. Er ersetzt das Passwort und lässt sich nicht abfischen.</p>
    <h3>Benachrichtigungen per E-Mail</h3>
    <label class="row"><input type="checkbox" data-change="mailSetting" data-key="email_progress" ${me.user.email_progress ? 'checked' : ''}>
      Neuigkeiten aus meinen Vorgängen: Nachrichten, Uploads, Entscheidungen (gebündelt, höchstens 3 Mails pro Stunde)</label>
    <label class="row"><input type="checkbox" data-change="mailSetting" data-key="email_reminders" ${me.user.email_reminders ? 'checked' : ''}>
      Morgens eine Übersicht mit neuen Aufgaben und nahenden Fristen</label>
  </main>`);
}

change.mailSetting = async el => { await api('/me', { method: 'PATCH', body: { [el.dataset.key]: el.checked } }); reload(); };

// Public page behind an upload link: who asks for what, one file field. Nothing about the case.
export async function uploadLinkView(token) {
  const l = await api(`/upload-links/${token}`);
  show(html`<main class="narrow"><h1>Datei bereitstellen</h1>
    <p>${l.requester} bittet ${l.label ? html`<b>${l.label}</b>` : 'Sie'}, für „${l.task}“ ${l.document ? `das Dokument „${l.document}“` : 'eine Datei'} hochzuladen.</p>
    <form data-submit="linkUpload" data-token="${token}" class="stack card">
      <input type="file" name="file" required>
      <button class="primary">Hochladen</button>
    </form>
    <p class="muted small">Erlaubt sind PDF, Bilder (PNG, JPG), Word, Excel, OpenDocument und Text bis 20 MB.
      Gültig bis ${dateTime(l.expires_at)}. Eine Anmeldung ist nicht nötig.</p>
  </main>`);
}

submit.linkUpload = async (fd, form) => {
  await api(`/upload-links/${form.dataset.token}`, { body: fd });
  show(html`<main class="narrow"><h1>Vielen Dank</h1><p>Die Datei „${fd.get('file').name}“ ist vollständig angekommen. Sie können dieses Fenster schließen.</p>
    <p class="muted small">Prüfsumme (SHA-256) als Nachweis, welche Datei Sie übermittelt haben:<br><code class="hash">${fd.get('sha256')}</code></p></main>`);
};

export async function loginLinkView(token) {
  await api('/login-link', { body: { token } });
  set({ me: await api('/me') });
  go(me.passkeys ? '#/' : '#/welcome');
}

submit.requestLink = async fd => {
  const { link } = await api('/login-link/request', { body: { email: fd.get('email') } });
  if (link) prompt('Lokal: der Anmeldelink', link);
  else alert('Falls es zu dieser Adresse ein Konto gibt, ist ein Anmeldelink unterwegs. Bitte schauen Sie in Ihr Postfach.');
};

// Right after joining: set up a passkey, otherwise the next visit needs a new link.
export function welcomeView(next) {
  page(html`<main class="narrow"><h1>Willkommen, ${me.user.name}</h1>
    <p>Richten Sie jetzt einen <b>Passkey</b> ein. Damit melden Sie sich künftig per Fingerabdruck, Gesichtserkennung oder
      Geräte-PIN an – ohne Passwort und ohne neuen Link.</p>
    <button class="block primary" data-on="welcomePasskey" data-next="${next}">Passkey einrichten</button>
    <p class="muted small">Am besten auf dem Gerät, mit dem Sie NomoCase meistens nutzen. Weitere Geräte fügen Sie später auf der Konto-Seite hinzu.</p>
    <p class="small"><a href="${next}">Später</a> <span class="muted">– ohne Passkey bleiben Sie nur auf diesem Gerät angemeldet.</span></p>
  </main>`);
}

on.welcomePasskey = webauthn(async ({ next }) => { await passkeyRegister(); go(next); });

export async function inviteView(token) {
  const inv = await api(`/invitations/${token}`);
  show(html`<main class="narrow"><h1>Einladung</h1>
    <p>${inv.inviter} lädt Sie zum Vorgang <b>${inv.case_title}</b> ein.</p>
    <p>Sie sind als <b>${inv.role}</b> beteiligt: ${inv.access === 'guest_viewer'
      ? `Sie können die für ${inv.role} freigegebenen Dokumente und Nachrichten lesen.`
      : STAFF.includes(inv.access) ? 'Sie sehen den ganzen Vorgang und arbeiten mit.'
      : `Sie sehen Ihre Aufgaben und die für ${inv.role} freigegebenen Dokumente und können Dateien hochladen und Nachrichten schreiben.`}</p>
    ${inv.needs_login
      ? html`<p>Für ${inv.email} gibt es bereits ein Konto. Bitte melden Sie sich zuerst an, danach können Sie die Einladung annehmen.</p>
        <button class="block primary" data-on="passkeyLogin">Mit Passkey anmelden</button>
        <button class="block" data-on="linkForInvite" data-email="${inv.email}">Anmeldelink an ${inv.email} schicken</button>
        <p class="muted small">Der Anmeldelink kommt per E-Mail. Öffnen Sie danach diesen Einladungslink noch einmal.</p>`
      : html`<form data-submit="accept" data-token="${token}" class="stack">
        <label class="stack">E-Mail <input value="${inv.email}" disabled></label>
        ${inv.existing ? '' : html`<label class="stack">Ihr Name <input name="name" required autofocus></label>`}
        <button>Einladung annehmen</button>
      </form>
      <p class="muted small">Danach können Sie einen Passkey einrichten, um sich später wieder anzumelden.</p>`}
  </main>`);
}

on.linkForInvite = async ({ email }) => {
  const { link } = await api('/login-link/request', { body: { email } });
  if (link) prompt('Lokal: der Anmeldelink', link);
  else alert(`Ein Anmeldelink ist an ${email} unterwegs.`);
};

submit.accept = async (fd, form) => {
  const { case_id } = await api('/invitations/accept', { body: { token: form.dataset.token, name: fd.get('name') } });
  set({ me: await api('/me') });
  go(me.passkeys ? `#/case/${case_id}` : `#/welcome/${case_id}`);
};
