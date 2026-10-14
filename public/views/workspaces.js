// Workspaces: create and rename them, members with their role, invitations, deleting an empty workspace.
import { change, me, on, submit } from '../state.js';
import { api, count, date, go, html, page, reload } from '../lib.js';

const ROLES = [['member', 'Mitglied'], ['owner', 'Owner']];
const roleSelect = (name, selected, attrs = '') => html`<select name="${name}" ${attrs}>${ROLES.map(([k, label]) =>
  html`<option value="${k}" ${k === selected ? 'selected' : ''}>${label}</option>`)}</select>`;

function workspaceCard(w) {
  const owner = w.role === 'owner';
  // the last owner can neither leave nor step down (the server refuses it too)
  const lastOwner = m => m.role === 'owner' && w.members.filter(x => x.role === 'owner').length === 1;
  return html`<div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${w.name}</h2>
      <span class="muted small">${count(w.cases, 'Vorgang', 'Vorgänge')} · ${count(w.templates, 'Vorlage', 'Vorlagen')} · Sie: ${owner ? 'Owner' : 'Mitglied'}</span></div>
    ${owner ? html`
      <details class="add"><summary>umbenennen</summary>
        <form data-submit="wsRename" data-id="${w.id}" class="row"><input name="name" value="${w.name}" required><button>Speichern</button></form></details>
      <h3>Mitglieder</h3>
      <ul class="list small">${w.members.map(m => html`<li class="row" style="justify-content:space-between">
        <span>${m.user_id === me.user.id ? 'Sie' : m.name} <span class="muted">${m.email}</span>${m.passkeys ? '' : html` <span class="tag internal">kein Passkey</span>`}</span>
        ${lastOwner(m) ? html`<span class="muted" title="Ein Workspace braucht mindestens einen Owner.">Owner</span>`
          : html`<span class="row">${roleSelect('role', m.role, `data-change="wsRole" data-id="${w.id}" data-user="${m.user_id}" aria-label="Rolle von ${m.name}"`)}
          <button class="link" data-on="wsRemove" data-id="${w.id}" data-user="${m.user_id}" data-name="${m.name}">${m.user_id === me.user.id ? 'verlassen' : 'entfernen'}</button></span>`}
      </li>`)}
      ${w.invitations.map(i => html`<li>${i.email} <span class="small ${i.expired ? 'warn' : 'muted'}">· ${ROLES.find(r => r[0] === i.role)[1]} ·
        ${i.expired ? `Einladung abgelaufen am ${date(i.expires_at)}` : `eingeladen, gültig bis ${date(i.expires_at)}`}</span>
        <span class="small"><button class="link" data-on="wsReinvite" data-id="${w.id}" data-email="${i.email}" data-role="${i.role}">erneut einladen</button>
          · <button class="link" data-on="wsWithdraw" data-id="${w.id}" data-email="${i.email}">zurückziehen</button></span></li>`)}</ul>
      <form data-submit="wsInvite" data-id="${w.id}" class="row small">
        <input name="email" type="email" placeholder="E-Mail" required aria-label="E-Mail">${roleSelect('role', 'member', 'aria-label="Rolle"')}<button>Einladen</button>
      </form>
      <h3>Erscheinungsbild der Formulare</h3>
      <p class="muted small">Logo und Akzentfarbe der PDF-Formulare, die NomoCase aus den Vorlagen dieses Workspace erzeugt
        (PNG oder JPEG, höchstens 300 KB). Die Vorschau gibt es auf der Seite „Vorlagen“.</p>
      <form data-submit="wsBranding" data-id="${w.id}" class="row small">
        <label class="row">Logo <input type="file" name="logo" accept="image/png,image/jpeg" aria-label="Logo"></label>
        <label class="row">Farbe <input type="color" name="accent" value="${w.accent ?? '#0f6e78'}" aria-label="Akzentfarbe"></label>
        <button>Speichern</button>
        ${w.has_logo ? html`<span class="muted">Logo hinterlegt · <button type="button" class="link" data-on="wsLogoRemove" data-id="${w.id}">entfernen</button></span>` : ''}
      </form>
      <h3>Vertrauenswürdige Aussteller</h3>
      <p class="muted small">Signaturen mit Zertifikaten dieser Aussteller (z. B. der CA Ihres Lehrstuhls) gelten als identifiziert,
        ohne dass jemand sie erst zuordnen muss.</p>
      ${w.issuers.length ? html`<ul class="list small">${w.issuers.map(i => html`<li>${i.name} <span class="muted">· seit ${date(i.added_at)}</span>
        <button class="link" data-on="wsIssuerRemove" data-id="${w.id}" data-fp="${i.fingerprint}" data-name="${i.name}">entfernen</button></li>`)}</ul>` : ''}
      <form data-submit="wsIssuer" data-id="${w.id}" class="row small"><input type="file" name="cert" accept=".cer,.crt,.pem,.der" required aria-label="Zertifikat des Ausstellers">
        <button>Aussteller hinzufügen</button></form>
      ${w.cases ? '' : html`<p class="small"><button class="link danger" data-on="wsDelete" data-id="${w.id}" data-name="${w.name}">Workspace löschen</button>
        <span class="muted">– geht nur ohne Vorgänge; ${w.templates ? 'die Vorlagen werden mitgelöscht' : 'er ist leer'}</span></p>`}`
    : html`<p class="muted small">Sie können aus den Vorlagen dieses Workspaces Vorgänge anlegen und sehen die, an denen Sie beteiligt sind.</p>`}
  </div>`;
}

export async function workspacesView() {
  const list = await api('/workspaces');
  page(html`<main class="narrow"><h1>Workspaces</h1>
    <p class="muted">Owner sehen alle Vorgänge eines Workspaces, pflegen seine Vorlagen und Mitglieder. Mitglieder legen aus den Vorlagen
      Vorgänge an und sehen die, an denen sie beteiligt sind. Externe (Studierende, Firmen …) werden nicht hier, sondern in einzelne
      Vorgänge eingeladen.</p>
    ${list.map(workspaceCard)}
    ${list.some(w => w.role === 'owner') ? html`<h2>Neuer Workspace</h2>
      <form data-submit="wsCreate" class="row"><input name="name" placeholder="Name, z. B. Lehrstuhl" required><button>Anlegen</button></form>` : ''}
  </main>`);
}

const invited = (email, { sent, link }) => (link
  ? prompt(sent ? 'E-Mail verschickt. Lokal zusätzlich der Link:' : 'E-Mail-Versand gerade nicht möglich. Bitte den Link selbst schicken:', link)
  : alert(`Einladung an ${email} verschickt.`));

submit.wsCreate = async fd => { await api('/workspaces', { body: { name: fd.get('name') } }); reload(); };
submit.wsRename = async (fd, form) => { await api(`/workspaces/${form.dataset.id}`, { method: 'PATCH', body: { name: fd.get('name') } }); reload(); };
submit.wsInvite = async (fd, form) => {
  invited(fd.get('email'), await api(`/workspaces/${form.dataset.id}/invitations`, { body: { email: fd.get('email'), role: fd.get('role') } }));
  reload();
};
on.wsReinvite = async ({ id, email, role }) => { invited(email, await api(`/workspaces/${id}/invitations`, { body: { email, role } })); reload(); };
on.wsWithdraw = async ({ id, email }) => {
  if (!confirm(`Einladung an ${email} zurückziehen?`)) return;
  await api(`/workspaces/${id}/invitations/${encodeURIComponent(email)}`, { method: 'DELETE' });
  reload();
};
change.wsRole = async el => {
  const self = el.dataset.user === me.user.id;
  if (self && el.value !== 'owner' && !confirm('Sie geben damit Ihre Owner-Rechte für diesen Workspace ab. Fortfahren?')) return reload();
  await api(`/workspaces/${el.dataset.id}/members/${el.dataset.user}`, { method: 'PATCH', body: { role: el.value } }).catch(e => { reload(); throw e; });
  reload();
};
on.wsRemove = async ({ id, user, name }) => {
  const self = user === me.user.id;
  if (!confirm(self ? 'Workspace verlassen? Beteiligungen an einzelnen Vorgängen bleiben.' : `${name} aus dem Workspace entfernen? Beteiligungen an einzelnen Vorgängen bleiben.`)) return;
  await api(`/workspaces/${id}/members/${user}`, { method: 'DELETE' });
  self ? go('#/') : reload();
};
// The issuer's certificate as PEM text or DER bytes (sent base64).
submit.wsIssuer = async (fd, form) => {
  const file = fd.get('cert'), text = await file.text();
  const certificate = text.includes('BEGIN CERTIFICATE') ? text : btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
  const { name } = await api(`/workspaces/${form.dataset.id}/issuers`, { body: { certificate } });
  alert(`„${name}“ ist jetzt ein vertrauenswürdiger Aussteller.`);
  reload();
};
const dataUrl = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(file); });
submit.wsBranding = async (fd, form) => {
  const logo = fd.get('logo');
  await api(`/workspaces/${form.dataset.id}/branding`, { method: 'PUT', body: { accent: fd.get('accent'), ...(logo?.size && { logo: await dataUrl(logo) }) } });
  reload();
};
on.wsLogoRemove = async ({ id }) => { await api(`/workspaces/${id}/branding`, { method: 'PUT', body: { logo: null } }); reload(); };

on.wsIssuerRemove = async ({ id, fp, name }) => {
  if (!confirm(`„${name}“ nicht mehr als vertrauenswürdig behandeln?`)) return;
  await api(`/workspaces/${id}/issuers/${fp}`, { method: 'DELETE' });
  reload();
};

on.wsDelete = async ({ id, name }) => {
  if (!confirm(`Workspace „${name}“ endgültig löschen?`)) return;
  await api(`/workspaces/${id}`, { method: 'DELETE' });
  reload();
};
