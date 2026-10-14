# NomoCase – Referenz

Wie NomoCase arbeitet, Teil für Teil. Überblick und Einstieg: [README](../README.md), Aufbau des Codes: [ARCHITECTURE](../ARCHITECTURE.md).

## Anmeldung

- **Passkeys** (WebAuthn) sind der einzige Login im Betrieb. Die Prüfung macht `@simplewebauthn/server`.
- **Gäste** bekommen ihren Einladungslink per E-Mail (14 Tage gültig, einmalig) und richten danach einen Passkey ein.
  Die einladende Person sieht den Link nie (sonst könnte sie das neue Konto für sich einrichten); scheitert der Versand,
  gibt es eine Fehlermeldung. Hat die eingeladene E-Mail schon ein Konto
  mit Passkey, muss man sich trotzdem erst damit anmelden.
- **Anmeldelink per E-Mail** (24 h, einmalig, höchstens alle 10 Minuten und fünf am Tag): selbst auf der Login-Seite anfordern, oder der
  Verantwortliche schickt ihn unter „Beteiligte“. Nach Einladung oder Link ohne Passkey folgt die Seite „Passkey einrichten“.
- **Owner/Recovery per CLI:** `npm run login-link -- <email> [--remote]`.
- **Einladungen öffnen nie ein bestehendes Konto**: Wer schon ein Konto hat (mit oder ohne Passkey), meldet sich erst an
  (Passkey oder Anmeldelink an die eigene Adresse) und nimmt dann an. Höchstens 5 Einladungen pro Adresse und Tag.
- **Schreibende Anfragen** nur von der eigenen Seite (Origin-Prüfung; ohne Origin-Header abgelehnt). Selbst angeforderte
  Anmeldelinks: höchstens 60 Mails pro Tag insgesamt, Antwort und Antwortzeit verraten nicht, ob es ein Konto gibt. Über ein
  Konto gehen höchstens 30 Mails am Tag hinaus (Einladungen, Upload-Links, Anmeldelinks), damit niemand das Kontingent
  aller verbraucht.
- **Sitzung** im Cookie `__Host-sid` (HttpOnly, Secure, SameSite=Lax, nur für diesen Host). Die Oberfläche kommt mit
  Content-Security-Policy, ohne Einbettung in fremde Seiten (`public/_headers`).
- **Lokal** gibt es zusätzlich den Dev-Login (`DEV_LOGIN` in `.dev.vars`, wird nie deployt; wirkt nur bei einer
  `ORIGIN` auf localhost).

## Modell und Funktionen

- **Vorlagen** sind versioniertes JSON (`roles`, `fields`, `document_types`, `phases[].tasks[]` mit `after`, `due_days` oder
  `due_field` (Frist aus einem Datumsfeld), `visible_to`, `money`, `labels` (eigene Entscheidungs-Buttons, z. B.
  „Bestanden“/„Nicht bestanden“; solche Entscheidungen halten ein Ergebnis fest und blockieren nicht), `form`, `rules`).
- **Formulare** (`forms`) beschreibt die Vorlage als Daten; am Schritt erscheint „Formular … vorausgefüllt herunterladen“.
  Der Server setzt die Werte des Vorgangs ein (wer den Schritt sieht, bekommt genau die Werte im Formular), der Browser
  erzeugt eine ausfüllbare PDF mit echten Signaturfeldern – digital unterschrieben erkennt die Signaturprüfung die Personen.
  Kommt das ausgefüllte Formular zurück, liest NomoCase die Felder: Abweichungen von den Angaben (z. B. ein geändertes
  Thema) erscheinen als Warnung, Werte für noch leere Angaben (z. B. die Note) übernimmt das Team – bei eigenen Uploads
  automatisch, bei Uploads von außen per Knopf.
  Beispiele: `templates/*.json` (u. a. Praxisprojekt, Masterprojekt, Bachelor- und Master-Thesis nach den Ordnungen des
  FB EI der HSD), durchgespielt in `test/praxisprojekt.mjs`. Logo und Akzentfarbe der Formulare sind Einstellungen des Workspace.
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
- **Bewertung** (`"assess": "<Skala>"` an review/approval/decision, Skalen unter `scales`): Prüfende tragen einen Wert auf
  der Skala ein (z. B. Note 1,0–4,0 in 0,1-Schritten oder 5,0); unter `pass` liegt „bestanden“. `aggregates` verrechnen mehrere
  Bewertungen (Mittel, Minimum, Maximum, Summe; abschneiden oder runden) und können das Ergebnis in ein Feld übernehmen.
  Einzelwerte sehen nur, die den Schritt sehen dürfen. Beispiele: Masterprojekt, Bachelor- und Master-Thesis.
- **Vorlagen löschen/archivieren**: ohne Vorgänge endgültig löschen, sonst archivieren (nicht mehr für neue Vorgänge,
  laufende behalten ihre Kopie), wiederherstellbar; die Vorlagen-Seite zeigt „läuft in N Vorgängen“.
- **Neue Version**: Offene Seiten fragen die ausgelieferte Version ab und laden nach einem Deployment selbst neu
  (beim Tippen nur ein Hinweis) – sonst liefe in einem lange offenen Tab weiter alter Code.
- **Live-Aktualisierung**: Übersicht und Vorgangsseite fragen alle 15 s (nur sichtbare Tabs) `GET /api/changes` nach dem
  Änderungsstand (letzte Event-ID; in der Übersicht zusätzlich die Zahl der Vorgänge) und laden bei Änderung neu, Scrollposition
  bleibt. Wird gerade getippt oder ist ein Menü offen, erscheint nur „Es gibt Neuigkeiten · Aktualisieren“. Upgrade-Pfad bei
  vielen gleichzeitigen Nutzern: Durable Object mit WebSockets.
- **Einwilligung**: Die Nutzung ist freiwillig (der bisherige Weg per E-Mail bleibt offen). Wer teilnimmt, willigt vorher ein:
  beim Annehmen einer Einladung (oder „Lieber per E-Mail“ – die einladende Person erfährt es im Vorgang), bei Upload-Links vor
  dem Hochladen, bestehende Konten nach der Anmeldung – vorher lässt der Server nichts zu. Text und Version in
  `public/shared/consent.js` (neue Version = alle werden erneut gefragt), Betreiber und Kontakt als `OPERATOR`/`PRIVACY_CONTACT`.
  Widerruf im Konto: abgemeldet, die Teams der Vorgänge werden informiert. Nachweis je Person auf „Personen“.
- **E-Mails an Vorgänge**: Jeder Vorgang hat eine nicht erratbare Adresse `v-…@<INBOX_DOMAIN>` (Details, nur Team). Mails an
  diese Adresse (auch in CC) landen als `.eml`-Dokument im Vorgang – Titel = Betreff, Absender als Hochlader, Anhänge im Verlauf,
  nur für das Team sichtbar, je Message-ID einmal; unbekannte Adressen werden abgewiesen, höchstens 100 Mails pro Vorgang und Tag.
  Einrichtung: Cloudflare Email Routing für die Domain aus `INBOX_DOMAIN`, Catch-all → Worker `nomocase`.
- **Digitale Signaturen in PDFs**: Beim Upload liest NomoCase eingebettete Signaturen (Acrobat/PAdES) aus und prüft, ob die
  signierten Bytes unverändert sind. Ein Schlüssel wird einer Person zugeordnet – durch sie selbst („Das ist meine Signatur“,
  nur wenn das Zertifikat ihre E-Mail-Adresse nennt), per Probe-PDF im Konto (ebenso) oder durch die Vorgangsverantwortlichen. Danach heißt es
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
  `decision.added`, `transaction.booked`, `case.closed`, `participant.joined`, `subcase.closed`, `signature.changed`,
  `form.mismatch`.
  Felder: `event.actor_role`, `task.key|title|type|role|outcome`, `document.type|title|version`, `claim.title|direction|amount|recognized|cut|settled|open`,
  `case.payables_open|receivables_open` (Beträge in Cent), `comment.text`. Operatoren: `equals`, `not_equals`, `greater_than`,
  `less_than`, `contains`, `in`. Aktionen: `create_task` (title, task_type, assign_to_role oder "owner", description,
  visible_to, due_days), `complete_tasks` (key, task_type oder title), `add_comment` (text, visible_to), `create_subcase` (template, title). Texte dürfen `{feld}`, `{date}` und `{date+N}` (heute + N Tage) enthalten.
  Jede Regel läuft pro Ereignis höchstens einmal (`automation_runs`), Folgen von Regeln lösen keine Regeln aus.
- **Finanzen** (Vorlage mit `"finance": true`, nur Staff): Forderungen (zu zahlen / Erstattung) mit Entscheidungen
  (letzte gilt) und Buchungen in Cent. Entscheidungen und Buchungen sind per Trigger unveränderlich, Korrektur nur per Storno.
  Die Übersicht wird immer berechnet. „Kürzung prüfen“ und „Zahlungsaufgabe abhaken“ sind Regeln der Arztrechnungs-Vorlage.
