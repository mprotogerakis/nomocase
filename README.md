# NomoCase

**Adaptive Fallbearbeitung für Verfahren mit mehreren Beteiligten.** Zum Beispiel Abschlussarbeiten, Praxisprojekte,
Anträge oder Erstattungen: alles, was heute per E-Mail, Formular und Ablage hin- und hergeht.

Aus einer **Vorlage** entsteht ein **Vorgang**. Er hat:
- Phasen und Schritten mit Zuständigen und Fristen,
- Dokumente mit Fassungen,
- einen lückenlosen Verlauf,
- Beteiligte mit genau den Rechten, die sie brauchen.

Jeder Vorgang lässt sich danach frei anpassen. Prozessspezifisches steht ausschließlich in den Vorlagen, nicht im Code.
Dieselbe Software trägt deshalb eine Bachelor-Thesis genauso wie eine Arztrechnung.

> Status: Prototyp im Einsatz am Fachbereich Elektro- & Informationstechnik der Hochschule Düsseldorf.

## Funktionen

**Vorlagen und Vorgänge**
- Vorlagen sind versioniertes JSON. Sie enthalten Rollen, Angaben, Dokumenttypen, Phasen mit Schritten (Aufgabe, Upload,
  Prüfung, Genehmigung, Unterschrift, Entscheidung, …), Abhängigkeiten, Fristen und Sichtbarkeiten.
- Regeln reagieren auf Ereignisse, etwa „Wenn die Thesis hochgeladen ist, die Bewertungsfrist mitteilen“. Sie legen
  Schritte an, schließen sie, schreiben Nachrichten oder starten Teilvorgänge.
- Fristen können an Datumsfeldern hängen und wandern mit, wenn sich das Datum ändert, etwa bei einer Verlängerung.
- Bewertungen arbeiten auf frei definierten Skalen, die Verrechnung ist einstellbar. Beispiel: Mittel zweier Noten,
  nur die erste Nachkommastelle zählt.
- Ein angepasster Vorgang lässt sich als neue Vorlage speichern.

**Formulare**
- Vorlagen beschreiben Formulare als Daten. NomoCase erzeugt daraus ausfüllbare, vorausgefüllte PDFs mit echten
  Signaturfeldern, auf Wunsch mit Logo und Farbe des Workspace.
- Ausgefüllt zurückgeladen, liest NomoCase die Felder wieder ein:
  - Abweichungen von den Angaben werden gewarnt.
  - Leere Angaben, etwa die Note, lassen sich übernehmen.

**Dokumente**
- Fassungen mit SHA-256-Prüfsumme. Der Browser rechnet sie aus, der Speicher prüft sie. Eine lokale Datei lässt sich
  abgleichen, ohne sie hochzuladen.
- Upload-Prüfung vor dem Speichern: Dateityp, aktive Inhalte in PDF und Office-Dateien (JavaScript, Makros, …).
  Uploads von außen werden strenger geprüft.
- Digitale Signaturen in PDFs werden gelesen und geprüft:
  - Ein Schlüssel wird einer Person zugeordnet.
  - Ein Wechsel des Schlüssels wird gemeldet.
  - Vertrauenswürdige Aussteller sind je Workspace hinterlegbar.
- E-Mails an die Adresse eines Vorgangs, auch in CC, landen als `.eml` im Vorgang.
- Upload-Links erlauben Externen ohne Konto genau einen Upload für genau einen Schritt.

**Beteiligte und Rechte**
- Workspaces mit Ownern und Mitgliedern.
- Im Vorgang: Verantwortliche, Team und Externe. Externe können mitwirken oder nur lesen und sehen nur, was für ihre
  Rolle freigegeben ist.
- Anmeldung mit Passkeys. Einladungen und Anmeldelinks kommen per E-Mail und werden erst nach einem Klick eingelöst,
  damit Mail-Scanner sie nicht verbrauchen.
- Arbeitsliste mit Fristen, „wartet auf … seit …“ und Live-Aktualisierung.
- Morgens eine Übersicht per Mail, Fortschrittsmails gebündelt.

**Datenschutz**
- Die Nutzung ist freiwillig: Wer teilnimmt, willigt vorher ein. Widerruf ist jederzeit möglich.
- Daten liegen in der EU (Cloudflare D1/R2 mit EU-Jurisdiktion).
- Der Verlauf nennt geänderte Felder, nicht ihre Werte. Löschfristen sind je Vorlage einstellbar.

Mehr Details: [docs/REFERENZ.md](docs/REFERENZ.md).

## Technik

| | |
|---|---|
| Server | Cloudflare Worker (JavaScript, ES-Module), gebündelt von wrangler |
| Daten | Cloudflare D1 (SQLite), Dateien in R2, beides mit EU-Jurisdiktion |
| E-Mail | Versand über Resend, Empfang über Cloudflare Email Routing |
| Oberfläche | Native ES-Module ohne Framework und ohne Build-Schritt, sicheres HTML über Tagged Templates |
| Abhängigkeiten | `@simplewebauthn/server` (Passkeys); `pdf-lib` mitgeliefert in `public/vendor/`, nur bei Bedarf geladen |

Der Aufbau des Codes, die Leitlinien und die Erweiterungspunkte stehen in [ARCHITECTURE.md](ARCHITECTURE.md).

## Schnellstart (lokal)

Voraussetzungen: Node.js 20+ und für die Browser-Tests Google Chrome.

```sh
npm install
printf 'DEV_LOGIN=1\nORIGIN=http://localhost:8787\nREDIRECT_HOSTS=\n' > .dev.vars
npm run db:init     # Schema, Demo-Konto, Workspaces und Beispielvorlagen
npm run dev         # http://localhost:8787 – Anmeldung lokal über den Dev-Login
```

Lokal läuft alles in Miniflare, ohne Cloudflare-Konto. Ohne Resend-Key werden Einladungs- und Anmeldelinks angezeigt
statt verschickt. `npm run db:reset` setzt die lokale Datenbank zurück. Vorher den Server stoppen.

## Tests

```sh
npm test            # im zweiten Terminal, gegen den laufenden `npm run dev`
```

Die Suite umfasst:
- **Bündeln:** Jeder Import hat seinen Export.
- **Unit-Tests:** Upload-Prüfung, Bewertung, PDF-Signaturen, Formulare.
- **API-Tests:** Rechte, Regeln, Mails, Finanzen und die Beispielvorlagen von Anfang bis Ende.
- **Browser-Test:** alle Ansichten in Headless Chrome.
- **Passkey-Anmeldung.**

Deployt wird nur nach grüner Suite.

## Betrieb

1. Cloudflare-Ressourcen anlegen:
   - `wrangler d1 create nomocase --jurisdiction eu`
   - `wrangler r2 bucket create nomocase-files --jurisdiction eu`
   - IDs und Domain in `wrangler.jsonc` eintragen.
2. Konfigurieren, siehe `vars` in `wrangler.jsonc`:

   | Variable | Bedeutung |
   |---|---|
   | `ORIGIN` | eigene Adresse; Passkeys hängen an dieser Domain |
   | `MAIL_FROM` | Absender |
   | `INBOX_DOMAIN` | Domain der Vorgangs-Adressen |
   | `REDIRECT_HOSTS` | frühere Domains, die umgeleitet werden |
   | `OPERATOR`, `PRIVACY_CONTACT` | Angaben im Einwilligungstext |

3. Secret setzen: `wrangler secret put RESEND_API_KEY`.
4. Datenbank anlegen und deployen:
   - `wrangler d1 migrations apply nomocase --remote`
   - `wrangler deploy`
   - Beispielvorlagen mit `npm run templates -- --remote`.
5. Ersten Zugang einrichten: `npm run login-link -- <email> --remote` erzeugt einen Anmeldelink, danach einen Passkey einrichten.

Notizen zur laufenden Instanz: [docs/BETRIEB.md](docs/BETRIEB.md). Den Einwilligungstext sollte vor dem Einsatz die
zuständige Datenschutzstelle prüfen.

## Projektstruktur

```
src/          Worker: Routen, Rechte, Vorgänge, Dokumente, Regeln, Mail, PDF-Prüfung, -Signaturen und -Formulare
public/       Oberfläche: app.js, views/, shared/ (mit dem Server geteilte Logik), vendor/pdf-lib
migrations/   Datenbankschema (D1)
templates/    Beispielvorlagen (JSON)
test/         Tests und synthetische Testdaten
scripts/      Vorlagen veröffentlichen, Anmeldelink per CLI
docs/         Referenz und Betriebsnotizen
```

## Lizenz

NomoCase ist **source-available** mit doppelter Lizenz:

- **Kostenlos für nicht-kommerzielle Zwecke** unter der [PolyForm Noncommercial License 1.0.0](LICENSE.md). Das umfasst
  private Nutzung, Lehre und Forschung sowie Hochschulen, öffentliche Einrichtungen und gemeinnützige Organisationen.
- **Kommerzielle Nutzung nur mit gesonderter Lizenz.** Alle kommerziellen Rechte liegen bei Michael Protogerakis.
  Mehr dazu in [COMMERCIAL.md](COMMERCIAL.md).

Drittkomponenten behalten ihre Lizenzen: pdf-lib (MIT, `public/vendor/pdf-lib.LICENSE.md`), @simplewebauthn/server (MIT).

Copyright © 2026 Michael Protogerakis
