# Architektur

NomoCase ist eine allgemeine Engine für adaptive Vorgänge. Was ein Praxisprojekt, eine Arztrechnung oder ein
Widerspruch ist, weiß nur die jeweilige Vorlage – nicht der Code.

## Leitlinien

1. **Keine Prozessspezifika im Code.** Rollen, Felder, Schritte, Fristen, Beschriftungen, Bewertungsskalen,
   Regeln und Finanzbegriffe stehen in Vorlagen (JSON). Der Code kennt nur allgemeine Konzepte wie
   „Schritt mit Entscheidung“, „Skala mit Bestehensgrenze“, „Forderung“, „Regel“. Rechtsgrundlagen (z. B. § 19
   einer Prüfungsordnung) erscheinen nur als Text aus der Vorlage.
2. **Vorlagen sind Daten und versioniert.** Ein Vorgang erhält eine Kopie der Vorlagenversion; neue Versionen
   ändern laufende Vorgänge nicht. Schritte behalten ihren Vorlagen-Schlüssel (`key`), damit Regeln und
   Auswertungen nicht an Titeln hängen.
3. **Der Server entscheidet.** Berechtigung, Sichtbarkeit, Bewertung und Fristen prüft der Worker; die Oberfläche
   zeigt an. Logik, die beide brauchen, liegt rein (ohne Imports) in `public/shared/` und wird von beiden importiert.
4. **Nachvollziehbar.** Das Ereignisprotokoll ist append-only, Geldbewegungen sind unveränderlich (Storno statt
   Änderung), Dateien sind versioniert und tragen ihre SHA-256-Prüfsumme.
5. **Gratis-Tarif-tauglich.** Wenige gelesene Zeilen pro Anfrage, Polling mit konstanten Kosten, rechenintensive
   Arbeit im Browser oder in R2 (z. B. Prüfsummen), Cron-Läufe mit gebündelten Schreibzugriffen.
6. **Kein Build-Schritt für die Oberfläche.** Native ES-Module; Fremdabhängigkeiten nur, wo es ohne nicht geht
   (WebAuthn auf dem Server).

## Aufbau

### Server (`src/`, von wrangler gebündelt)

| Modul | Aufgabe |
|---|---|
| `worker.js` | Routen, Anfrage-Rahmen (Origin-Prüfung, Sitzung, Fehler → JSON), Cron-Einstieg |
| `core.js` | Fehler, JSON-Antworten, D1-Helfer, Ereignisprotokoll, Bindings (`init(env)`) |
| `access.js` | Vorgangskontext, wer was sehen und tun darf |
| `auth.js` | Sitzungen, Passkeys, Anmeldelinks, eigenes Konto |
| `templates.js` | Vorlagenprüfung (`checkDef`), Versionen, Vorgang anlegen, Vorgang → Vorlage |
| `cases.js` | Übersicht, Vorgangsansicht, Angaben, Status, Nachrichten, Phasen, Teilvorgänge, Löschen, Änderungsstand |
| `tasks.js` | Blockierung, Bearbeiten, Aktionen (erledigen, entscheiden, bewerten, Rückfrage, überspringen) |
| `finance.js` | Forderungen, Entscheidungen, Buchungen; Geldschritte |
| `rules.js` | Regel-Engine: Auslöser, Bedingungen, Aktionen; idempotent je Ereignis |
| `documents.js` | Upload-Prüfung, Fassungen in R2, Upload-Links, Downloads |
| `people.js` | Einladungen (auch die Annahme von Workspace-Einladungen), Beteiligte, Personenübersicht |
| `workspaces.js` | Workspaces anlegen/umbenennen/löschen, Mitglieder (Owner/Mitglied), Workspace-Einladungen, Erscheinungsbild der Formulare (Logo, Farbe) |
| `notify.js` | Mail über Resend, Tageskontingente, Tagesübersicht, gebündelte Fortschrittsmails, Testmail |
| `inbox.js` | Mail in einen Vorgang: Adresse je Vorgang, Empfang über Cloudflare Email Routing, Ablage als `.eml` |
| `validate.js` | Inhaltsprüfung hochgeladener Dateien (aktive Inhalte in PDF/Office) |
| `pdfsig.js` | Digitale Signaturen in PDFs lesen und prüfen (CMS/PAdES, RSA/ECDSA, Kette zu vertrauenswürdigen Ausstellern) – rein, ohne DB |
| `signatures.js` | Signaturen speichern und deuten: bekannter Schlüssel, vertrauenswürdiger Aussteller, „andere Signatur als bisher“; Zuordnen |
| `forms.js` | Formular eines Schritts mit den Werten des Vorgangs füllen (nur wer den Schritt sieht, nur was im Formular steht); hochgeladene Formulare erkennen und mit den Angaben abgleichen |
| `pdfform.js` | Feldwerte ausgefüllter PDF-Formulare lesen (AcroForm, auch Objekt-Streams und angehängte Änderungen) – rein, ohne DB |

Abhängigkeiten zeigen nach innen: `worker` → Fachmodule → `access` → `core`. Zwischen Fachmodulen gibt es
Aufrufe in beide Richtungen, aber nur zur Laufzeit (keine Auswertung beim Laden).

### Oberfläche (`public/`)

| Modul | Aufgabe |
|---|---|
| `app.js` | Einstieg: Hash-Router, Live-Aktualisierung, Event-Delegation (`data-on`, `data-submit`, `data-change`) |
| `state.js` | Gemeinsamer Zustand (`me`, `cur`, `stamp`, `templates`) mit `set()`, Handler-Register |
| `lib.js` | Sicheres HTML (`html`/`esc`), Formatierung, Beschriftungen, API-Client, Navigation, Seitenrahmen |
| `views/*.js` | Ansichten: `account`, `dashboard`, `admin`, `workspaces`, `case`, `tasks`, `documents`, `finance`, `template-editor` (Vorlage als Formular statt JSON) |
| `shared/vocab.js` | Begriffe, die Server und Oberfläche teilen (Zugriffsstufen, Aufgabentypen) |
| `shared/forms.js` | Formulare der Vorlage: Prüfung, Platzhalter füllen (Server: echte Werte, Vorschau: Platzhalternamen) |
| `formpdf.js` | Formular als ausfüllbare PDF mit Signaturfeldern; lädt `vendor/pdf-lib` erst bei Bedarf (nichts von Fremdservern) |

Jede Ansicht registriert ihre Handler selbst (`on.x = …`). Ein Test verhindert doppelte Handlernamen über alle
Module hinweg.

### Tests (`npm test`, gegen `npm run dev`)

`check` (Server und Oberfläche bündeln: jeder Import hat seinen Export) · `validate` (Upload-Prüfung, ohne Server) ·
`assess`, `pdfsig`, `forms` (Bewertung, Signaturen, Formular-PDFs, ohne Server) · `smoke` (Berechtigungen, Finanzen, Regeln, Mails) ·
`praxisprojekt` (Beispielvorlagen von Anfang bis Ende) · `ui` (alle Ansichten im echten Browser, ohne Skriptfehler, auch in Handy-Breite, jedes Bedienelement mit Namen für Screenreader und per Tastatur erreichbar) ·
`passkey` (Anmeldung, auch gegen Produktion). `test/browser.mjs` steuert Chrome über das DevTools-Protokoll.

## Erweiterungspunkte der Vorlage

`roles`, `fields`, `document_types`, `phases[].tasks[]`, `rules`, `finance`, `retention_days`; je Schritt u. a.
`key`, `type`, `role`, `after`, `due_days`/`due_field` (die Frist folgt dem Datumsfeld, auch wenn es erst später gesetzt
oder geändert wird), `visible_to`, `labels`, `money`, `assess`, `form`, `files` (`{ "multiple": true, "accept": ["pdf", "image", "word", "excel", "text"] }`:
mehrere Dateien bzw. erlaubte Dateiarten, vom Server geprüft – auch über Upload-Links). Regeln: `trigger`,
`conditions` (Fakten wie `task.key`, `document.type`, `claim.open`), `actions` (`create_task`, `complete_tasks`,
`add_comment`, `create_subcase`). Dazu `due_base_field` (Datumsfeld, ab dem `due_days` zählen), `finance`
(`true` oder `{ "labels": { … } }` mit eigenen Begriffen), `scales` (Skala: `range`+`step`+`extra` oder `options`,
`pass`, `verdicts`, `hint`) und `aggregates` (`from` Schritt-Keys, `method`, `round`, `fail_value`, `field`, `note`).
`forms` (Formulare, die NomoCase als ausfüllbare PDF erzeugt: `title`, `subtitle`, `header`, `items` aus
`heading`/`text`/`label`(+`value`, `half`, `lines`, `check`)/`sign`(+`name`, `place`); Platzhalter `{field.x}`, `{role.x}`,
`{role.x.email}`, `{case.title}`, `{date+N}` nur in `value`/`name`/`place` – Werte aus dem Vorgang stehen immer in
korrigierbaren Feldern, nie im gedruckten Text), am Schritt `form`. Logo und Akzentfarbe gehören dem Workspace. Neue fachliche
Anforderungen werden als allgemeines Konzept hier ergänzt, nicht als Sonderfall im Code.

## Umbauplan

Jeder Schritt wird mit grünen Tests ausgeliefert.

- [x] Sicherheitsnetz: UI-Test im Browser, gemeinsamer Browser-Helfer
- [x] Server in Fachmodule aufgeteilt (reines Verschieben, Importe aus tatsächlicher Verwendung abgeleitet)
- [x] Oberfläche in ES-Module aufgeteilt, gemeinsame Begriffe in `public/shared/vocab.js`
- [x] Regeln zuverlässig genau einmal (Laufprotokoll und Wirkung in einem Batch), Fehlerläufe mit Grund sichtbar
- [x] Stabile Schritt-Schlüssel (`tasks.key`); Regeln verweisen per Schlüssel (Bedingung `task.key`, `complete_tasks.key`,
      `create_task.key`), die Vorlagenprüfung lehnt unbekannte Schlüssel ab; Umbenennen schaltet keine Regel mehr ab
- [x] Bewertung allgemein: `scales` und `aggregates` in der Vorlage, Logik in `public/shared/assess.js` (Unit-Test
      `test/assess.mjs`); Schritte speichern `assess`/`score`; die Notenlogik ist aus dem Code verschwunden
- [x] `due_base_field` statt fest verdrahtetem Feld `start`, `finance.labels` statt Erstattungsbegriffen,
      neutrale Platzhalter; Handler-Fehler werden zentral behandelt (kein stummer Klick, kein Doppel-Hinweis)
- [ ] Bei Bedarf: Verhalten je Schritt überschreibbar machen (`on_reject`, `allow_question`); heute gilt:
      beschriftete Entscheidungen und Bewertungen blockieren nicht, Bewertungen kennen keine Rückfrage und gehen
      nur an die, die den Schritt sehen
- [x] Beispielvorlagen als JSON-Dateien (`templates/`), veröffentlicht mit `npm run templates [-- --remote]`;
      über die Oberfläche geänderte Versionen werden nur mit `--force` ersetzt
- [ ] Kosten: Änderungsstand per Trigger, Übersicht in SQL verdichten, Aufräumen alter Benachrichtigungen
- [x] Übersicht als Arbeitsliste: Suche ohne Neuaufbau, Filter, Sortierung nach Dringlichkeit, „wartet auf … seit“,
      überfällig bei anderen, „+ Neuer Vorgang“ oben
- [x] Einladungen/Personen: abgelaufene Einladungen sichtbar, erneutes Einladen ersetzt, Suche/Filter/Aktionen auf „Personen“
- [x] Workspaces verwalten: anlegen, umbenennen, löschen (nur ohne Vorgänge), Mitglieder mit Rolle, Einladungen
      (gleiche Annahme-Seite und gleicher Kontoschutz wie bei Vorgängen); der letzte Owner bleibt
- [x] Vorlagen löschen bzw. archivieren (wenn schon in Vorgängen), „läuft in N Vorgängen“, wiederherstellen
- [x] Offene Tabs bemerken neue Deployments (`/api/version`, Binding `CF_VERSION_METADATA`) und laden neu
- [x] Mail in Vorgänge: Adresse `v-…@INBOX_DOMAIN` je Vorgang, `.eml` als Dokument (nur Team), je Message-ID einmal
- [x] Einwilligung (freiwillige Nutzung): bei Einladung, Upload-Link und nach der Anmeldung, serverseitig erzwungen,
      versioniert, widerrufbar, Nachweis je Person
- [x] Anhänge eingehender Mails als eigene, geprüfte Dokumente: im Browser aus der `.eml` gelöst (`public/shared/mime.js`),
  je Anhang ein normaler Upload mit allen Prüfungen, schon vorhandene (gleiche SHA-256) übersprungen
- [x] Massenanlage: Tabelle aus Excel einfügen, Vorschau mit Prüfung je Zeile, Vorgänge samt Einladung anlegen
  (`public/shared/bulk.js` liest die Tabelle, eine Anfrage je Vorgang und Einladung – alle üblichen Prüfungen und Limits)
- [x] Digitale Signaturen in PDFs: Schlüssel wiedererkennen (Erstkontakt + Bestätigung), vertrauenswürdige Aussteller je
      Workspace, Warnung bei anderem Schlüssel (Ereignis `signature.changed`, Regel-Auslöser); keine Rechtsprüfung, kein CRL/OCSP
- [x] Formulare aus der Vorlage: vorausgefüllte, ausfüllbare PDFs mit Signaturfeldern, Logo und Akzentfarbe je Workspace,
  Vorschau auf der Vorlagenseite (Bachelor- und Master-Thesis: Zulassung, Verlängerung, Notenmitteilung)
- [x] Hochgeladene Formulare zurücklesen: an den Feldnamen erkannt, Abweichungen von den Angaben als Warnung (Ereignis
  `form.mismatch`, auch Regel-Auslöser), leere Angaben aus Team-Uploads direkt übernommen, von außen per Knopf
- [ ] Formulare auch für Praxisprojekt und Masterprojekt
- [x] Sicherheitsprüfung vor der Veröffentlichung: Signaturketten nur über echte CAs, Parser gegen präparierte Dateien,
  keine Einladungslinks an Einladende, Mail-Limit je Person, CSP und Header, Origin-Pflicht, `__Host-`-Cookie
- [x] Tokens aus URL-Pfaden in den Request-Body (Einladung, Upload-Link): Pfade landen in den Worker-Logs
- [ ] Anmeldelink-Anfragen zusätzlich pro IP begrenzen (Workers Rate Limiting), falls das Tageskontingent missbraucht wird
- [x] Vorlagen-Editor, Stufe 1: Rollen, Angaben, Dokumenttypen, Phasen und Schritte (Typ, Rolle, Reihenfolge, Frist,
  Dokument, Upload-Einstellungen, Beschreibung) als Formular; Regeln, Formulare, Bewertung, Geld weiter als JSON
- [x] Vorlagen-Editor, Stufe 2a: Regeln als Formular (Auslöser, Bedingungen mit Auswahllisten, Aktionen je Typ)
- [x] Vorlagen-Editor, Stufe 2b: PDF-Formulare als Formular (Einträge je Art, Werte aus einer Liste von Platzhaltern
  oder fester Text, Zuordnung zum Schritt, Vorschau); als JSON bleiben nur Bewertung (`scales`/`aggregates`) und Geld
- ~~Dokumente in mehreren Vorgängen~~ – nicht gewünscht (17.10.); gebraucht wird das Verschieben ganzer Vorgänge (umgesetzt)
- [x] Prüfung auf freie Variablen (fehlende Importe) in `npm run check` (`scripts/freevars.mjs`); esbuild meldet sie nicht
- [x] Workspace-Änderungen protokollieren (`workspace_events`, nur ergänzbar): Name, Mitglieder, Rollen, Einladungen,
  Erscheinungsbild, Aussteller, Vorlagen, verschobene Vorgänge; für Owner auf der Workspace-Seite
