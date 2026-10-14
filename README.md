# NomoCase – Prototyp

Adaptive Case Management: Vorlagen → unabhängige Vorgänge mit Aufgaben, Dokumenten, Verlauf und Gästen.
Cloudflare Worker + D1 + R2, lokal komplett über `wrangler dev` (Miniflare).

```sh
npm install
npm run db:init     # Schema + Demo-Vorlagen (Hochschule, Privat)
npm run dev         # http://localhost:8787 (mit --test-scheduled für den Cron-Test)
npm test            # zweites Terminal: Upload-, API-, Digest- und Passkey-Test (Headless Chrome), legt Demodaten an
npm run db:reset    # alles lokal löschen (Server vorher stoppen)
```

## Anmeldung

- **Passkeys** (WebAuthn) sind der einzige Login im Betrieb. Die Prüfung macht `@simplewebauthn/server`.
- **Gäste** bekommen ihren Einladungslink per E-Mail (14 Tage gültig, einmalig) und richten danach einen Passkey ein.
  Nur wenn der Versand scheitert, sieht die einladende Person den Link. Hat die eingeladene E-Mail schon ein Konto
  mit Passkey, muss man sich trotzdem erst damit anmelden.
- **Anmeldelink per E-Mail** (24 h, einmalig, höchstens alle 10 Minuten): selbst auf der Login-Seite anfordern, oder der
  Verantwortliche schickt ihn unter „Beteiligte“. Nach Einladung oder Link ohne Passkey folgt die Seite „Passkey einrichten“.
- **Owner/Recovery per CLI:** `npm run login-link -- <email> [--remote]`.
- **Einladungen öffnen nie ein bestehendes Konto**: Wer schon ein Konto hat (mit oder ohne Passkey), meldet sich erst an
  (Passkey oder Anmeldelink an die eigene Adresse) und nimmt dann an. Höchstens 5 Einladungen pro Adresse und Tag.
- **Schreibende Anfragen** nur von der eigenen Seite (Origin-Prüfung). Selbst angeforderte Anmeldelinks: höchstens 20 Mails pro Tag,
  Antwort und Antwortzeit verraten nicht, ob es ein Konto gibt.
- **Lokal** gibt es zusätzlich den Dev-Login (`DEV_LOGIN` in `.dev.vars`, wird nie deployt).

## Deployment

Live unter https://nomocase.example.org (workers.dev ist abgeschaltet: Passkeys hängen an der Domain). Die frühere Domain
nomocase-old.example.org leitet dauerhaft dorthin um (`REDIRECT_HOSTS`); dort angelegte Passkeys gelten auf der neuen Domain nicht.
D1 und R2 liegen in der EU-Jurisdiktion. Der Token liegt in `nomocase.token.cloudflare.credential` (gitignored).
E-Mails gehen über Resend (Domain `nomocase-old.example.org`, Region EU, Absender `noreply@nomocase-old.example.org` – bis
`nomocase.example.org` bei Resend verifiziert ist);
der Sende-Key liegt in `resend.credential` und als Worker-Secret `RESEND_API_KEY`. Ohne Key werden Einladungslinks
angezeigt und die tägliche Übersicht (Cron 05:00 UTC) pausiert.

```sh
export CLOUDFLARE_API_TOKEN=$(tr -d '[:space:]' < nomocase.token.cloudflare.credential)
npx wrangler d1 migrations apply nomocase --remote   # nur bei neuen Migrationen
npx wrangler deploy
BASE=https://nomocase.example.org EMAIL=<owner> node test/passkey.mjs   # Check gegen Produktion
npm run login-link -- <email> --remote                                     # Recovery
tr -d "[:space:]" < resend.credential | npx wrangler secret put RESEND_API_KEY   # Mail-Key (erledigt)
```

Erstinstallation (erledigt): `wrangler d1 create nomocase --jurisdiction eu`, `wrangler r2 bucket create nomocase-files --jurisdiction eu`,
Migrationen + `seed.sql` remote, danach Owner-Konto `u_prof` per `UPDATE users` auf die echte E-Mail gesetzt.

## Aufbau

Siehe [ARCHITECTURE.md](ARCHITECTURE.md): Leitlinien, Module von Server (`src/`) und Oberfläche (`public/`), Tests,
Umbauplan. Dazu `migrations/` (Schema), `seed.sql` (Demo-Konto und Workspaces), `templates/*.json` (Beispielvorlagen,
veröffentlicht mit `npm run templates`, Produktion: `npm run templates -- --remote`), `scripts/login-link.mjs` (Anmeldelink per CLI).

## Modell in einem Satz pro Teil

- **Vorlagen** sind versioniertes JSON (`roles`, `fields`, `document_types`, `phases[].tasks[]` mit `after`, `due_days` oder
  `due_field` (Frist aus einem Datumsfeld), `visible_to`, `money`, `labels` (eigene Entscheidungs-Buttons, z. B.
  „Bestanden“/„Nicht bestanden“; solche Entscheidungen halten ein Ergebnis fest und blockieren nicht), `rules`).
  Beispiel nach dem Prozessplan des FB EI: „Praxisprojekt (B.Eng.)“ in `seed.sql`, durchgespielt in `test/praxisprojekt.mjs`.
  Ein Vorgang kopiert die Definition; Phasen und Aufgaben werden zu eigenen Zeilen und sind danach frei änderbar.
- **Rollen** sind Plätze im Vorgang (z. B. „Studierende:r“). Personen werden in eine Rolle eingeladen; Aufgaben und
  Freigaben gehen an die Rolle, eine Person genügt. Zugriffsstufen: Verantwortlich, Team (sieht alles),
  Extern · mitwirkend, Extern · nur lesen. Neue Rollen lassen sich beim Einladen anlegen.
- **Externe** bekommen keine Feldwerte und keine Regeln, legen nur Dokumente freigegebener Typen an und schreiben mit
  „nur lesen“ keine Nachrichten. Einzelne Fassungen lassen sich löschen (Team: jede, Externe: die eigene aktuelle).
- **Sichtbarkeit**: Dokumente, Ereignisse und Kommentare tragen `visible_to` (Rollen-Keys, `*` = alle, `[]` = nur Team).
  Das Team sieht alles, Externe nur Freigegebenes und Eigenes. Aufgaben sieht, wer die zuständige Rolle hat.
- **Ergebnisse**: Jede Dokumentversion merkt sich die Aufgabe, über die sie kam (`document_versions.task_id`); die Aufgabe
  zeigt ihr Ergebnis, frühere Fassungen und Rückfragen. Upload- und Unterschrift-Aufgaben gehen nur mit Datei zu Ende,
  bei Entscheidungen wird eine Datei nur angehängt. Externe legen neue Fassungen nur über Aufgaben oder auf ihrer eigenen
  letzten, nicht finalen Fassung an.
- **Verlauf** ist append-only (DB-Trigger). Kommentare sind Ereignisse vom Typ `comment`.
- **Rückfrage** bei Prüfungen öffnet die vorherige Aufgabe wieder (Korrekturschleife ohne Regel-Engine).
- **Anliegen**: Gäste können den Prozess nicht ändern, aber z. B. eine Verlängerung beantragen → Entscheidungsaufgabe für die verantwortliche Person.
- **Upload-Prüfung** (`src/validate.js`, vor dem Speichern): Endung + Magic Bytes, dann aktive Inhalte.
  PDF: JavaScript, Launch, XFA u. a., auch in komprimierten Objekt-Streams und mit `#xx`-Codierung.
  Office: Makros, ActiveX, OLE, externe Vorlagen. ODF: Makros. Gäste dürfen zusätzlich keine eingebetteten Dateien
  und keine verschlüsselten PDFs hochladen. Abgelehnte Uploads werden nie gespeichert, aber protokolliert.
  Das ist kein Signatur-Virenscanner; Upgrade-Pfad: ClamAV in einem Cloudflare Container.
- **Benachrichtigungen**: Einladungen per Mail. Fortschritt (Nachrichten, Uploads, Entscheidungen anderer) gebündelt alle
  20 Minuten, höchstens 3 Mails pro Stunde und Person. Morgens eine Übersicht mit neuen Aufgaben und Fristen
  (7 Tage, morgen, überfällig). Sammelmails stoppen bei `MAIL_DAILY_CAP` (Standard 80/Tag, Resend-Gratis: 100),
  Einladungen und Anmeldelinks gehen immer. Beides getrennt abbestellbar auf der Konto-Seite.
- **Sichtbarkeit pro Schritt**: Aufgaben haben eine zuständige Rolle und optional `visible_to` (Vorlage oder „⋯“-Menü).
  Externe sehen unter „Ablauf“ ihre und die für sie freigegebenen Schritte.
- **Teilvorgänge**: eigene Vorgänge (Vorlage, Beteiligte, Regeln) mit `parent_case_id`; „+ Teilvorgang“ unter Details oder per
  Regel-Aktion `create_subcase` (z. B. Arztrechnung: „Kürzung prüfen“ beanstandet → Teilvorgang „Widerspruch“). Abschluss meldet
  `subcase.closed` an den Hauptvorgang; Löschen nimmt Teilvorgänge mit; Titel anderer Vorgänge sieht nur, wer sie öffnen darf.
- **Upload-Links** (⋯-Menü einer Aufgabe mit Datei): Externe ohne Konto laden genau eine Datei für genau diese Aufgabe hoch,
  standardmäßig einmalig, mit Ablaufdatum, strenger Prüfung und Protokoll; widerrufbar. Die Datei trägt den Namen aus dem Link.
- **SHA-256 je Fassung**: Der Browser berechnet die Prüfsumme beim Hochladen, R2 prüft sie beim Speichern (keine Worker-CPU);
  ohne mitgeschickte Prüfsumme rechnet der Worker selbst. Sie steht an jeder Fassung (Klick kopiert), im Verlauf und als Quittung
  nach Upload-Links. „Datei abgleichen“ unter Dokumente vergleicht eine lokale Datei, ohne sie hochzuladen. Ältere Fassungen: ohne.
- **Benotung** (`"grade": true` an review/approval/decision): Note 1,0–4,0 in 0,1-Schritten oder 5,0 (§ 19 Abs. 3 RahmenPO EI)
  statt zwei Knöpfen; 5,0 zählt als Ablehnung (Regel-Trigger `task.reject`), blockiert aber nicht. Die Note geht nur an die, die
  den Schritt sehen dürfen (Studierende standardmäßig nicht). Beispiel: Vorlage „Masterprojekt (M.Sc.)“.
- **Vorlagen löschen/archivieren**: ohne Vorgänge endgültig löschen, sonst archivieren (nicht mehr für neue Vorgänge,
  laufende behalten ihre Kopie), wiederherstellbar; die Vorlagen-Seite zeigt „läuft in N Vorgängen“.
- **Neue Version**: Offene Seiten fragen die ausgelieferte Version ab und laden nach einem Deployment selbst neu
  (beim Tippen nur ein Hinweis) – sonst liefe in einem lange offenen Tab weiter alter Code.
- **Live-Aktualisierung**: Übersicht und Vorgangsseite fragen alle 15 s (nur sichtbare Tabs) `GET /api/changes` nach dem
  Änderungsstand (letzte Event-ID; in der Übersicht zusätzlich die Zahl der Vorgänge) und laden bei Änderung neu, Scrollposition
  bleibt. Wird gerade getippt oder ist ein Menü offen, erscheint nur „Es gibt Neuigkeiten · Aktualisieren“. Upgrade-Pfad bei
  vielen gleichzeitigen Nutzern: Durable Object mit WebSockets.
- **Digitale Signaturen in PDFs**: Beim Upload liest NomoCase eingebettete Signaturen (Acrobat/PAdES) aus und prüft, ob die
  signierten Bytes unverändert sind. Ein Schlüssel wird einer Person zugeordnet – durch sie selbst („Das ist meine Signatur“,
  nur wenn das Zertifikat sie nennt), per Probe-PDF im Konto oder durch die Vorgangsverantwortlichen. Danach heißt es
  „signiert von … (Schlüssel bekannt seit …)“; ein anderer Schlüssel unter bekanntem Namen wird gewarnt und protokolliert
  (`signature.changed`). Workspaces können Aussteller als vertrauenswürdig hinterlegen (z. B. die eigene CA). Kein Ersatz
  für eine QES-Prüfung, keine Sperrlisten.
- **Workspaces** (Menü): Owner legen Workspaces an, benennen sie um, laden Kolleg:innen als Owner oder Mitglied ein
  (gleicher Link-Ablauf wie bei Vorgängen) und löschen leere Workspaces. Owner sehen alle Vorgänge und pflegen Vorlagen,
  Mitglieder legen aus den Vorlagen Vorgänge an und sehen ihre eigenen. Externe werden weiter pro Vorgang eingeladen.
- **Personen** (Menü, nur Workspace-Owner): alle Konten in den eigenen Workspaces und deren Vorgängen, auch frühere, mit
  Passkey-Status, letzter Anmeldung, Mail-Einstellungen, Plätzen je Vorgang, offenen Einladungen und dem Mail-Kontingent von heute.
- **Angaben bearbeiten** (rechte Spalte, „bearbeiten“; nur Team): Ändert sich ein Datumsfeld, wandern offene Aufgaben mit,
  deren Frist noch auf dem alten Datum steht. Der Verlauf nennt nur die geänderten Felder, nicht die Werte.
- **Vorgang als Vorlage speichern** (Details → Vorgang): übernimmt Rollen, Felder ohne Inhalte, Dokumenttypen, Phasen, Aufgaben,
  Fristen (relativ bzw. `due_field`), Sichtbarkeit und Regeln; keine Dokumente, Nachrichten, Personen, Anliegen oder Regel-Aufgaben.
- **Löschen**: „Vorgang löschen“ entfernt alles inkl. Dateien in R2 und unveränderlicher Buchungen; es bleibt nur ein
  Eintrag in `case_deletions` ohne Inhalte. Externe, die sonst nirgends beteiligt sind, verlieren ihr Konto.
  Mit `"retention_days": N` in der Vorlage löscht der Cron abgeschlossene Vorgänge N Tage nach Abschluss (Ankündigung 14 Tage vorher).
- **Geldschritte** an Vorlagen-Aufgaben (`"money"`): `{"claim": "Rechnung", "direction": "payable", "counterparty_field": "doctor"}`
  legt beim Erledigen mit Betrag die Forderung an, `{"decision": "PKV"}` erfasst die Entscheidung, `{"payment": "PKV"}` bucht
  die Zahlung.
- **Regeln** (`"rules"` in der Vorlage, pro Vorgang an-/abschaltbar unter „Automatik“):
  `{"id", "name", "trigger", "conditions": [{"field", "operator", "value"}], "actions": [...]}`.
  Trigger: `document.uploaded`, `task.complete|approve|reject|question`, `request.created`, `comment`, `claim.added`,
  `decision.added`, `transaction.booked`, `case.closed`, `participant.joined`.
  Felder: `event.actor_role`, `task.title|type|role|outcome`, `document.type|title|version`, `claim.title|direction|amount|recognized|cut|settled|open`,
  `case.payables_open|receivables_open` (Beträge in Cent), `comment.text`. Operatoren: `equals`, `not_equals`, `greater_than`,
  `less_than`, `contains`, `in`. Aktionen: `create_task` (title, task_type, assign_to_role oder "owner", description,
  visible_to, due_days), `complete_tasks` (task_type oder title), `add_comment` (text, visible_to), `create_subcase` (template, title). Texte dürfen `{feld}`, `{date}` und `{date+N}` (heute + N Tage) enthalten.
  Jede Regel läuft pro Ereignis höchstens einmal (`automation_runs`), Folgen von Regeln lösen keine Regeln aus.
- **Finanzen** (Vorlage mit `"finance": true`, nur Staff): Forderungen (zu zahlen / Erstattung) mit Entscheidungen
  (letzte gilt) und Buchungen in Cent. Entscheidungen und Buchungen sind per Trigger unveränderlich, Korrektur nur per Storno.
  Die Übersicht wird immer berechnet. „Kürzung prüfen“ und „Zahlungsaufgabe abhaken“ sind Regeln der Arztrechnungs-Vorlage.
