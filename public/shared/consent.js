// Consent to the processing in NomoCase (Art. 6 Abs. 1 lit. a DSGVO). Using NomoCase is voluntary: the conventional way
// by e-mail stays open without any disadvantage. Shared by the Worker (current version) and the UI (text).
// Changing the text means raising CONSENT_VERSION: everyone is asked again. Operator and contact come from the
// configuration (vars OPERATOR, PRIVACY_CONTACT) – the text has to be reviewed by the data protection officer.
export const CONSENT_VERSION = '2026-10-14';

export const consentText = ({ operator, contact }) => [
  ['Freiwillig', 'NomoCase ist ein freiwilliges Angebot. Ihr Verfahren (zum Beispiel ein Praxis- oder Masterprojekt) lässt sich genauso '
    + 'auf dem bisherigen Weg per E-Mail abwickeln – ohne jeden Nachteil.'],
  ['Was gespeichert wird', 'Ihr Name und Ihre E-Mail-Adresse, Ihre Rolle in Vorgängen, Dokumente und Nachrichten, die Sie oder andere '
    + 'einstellen, die Bearbeitungsschritte mit Zeitpunkt sowie der öffentliche Teil Ihres Passkeys für die Anmeldung (keine biometrischen Daten).'],
  ['Wozu', 'Damit alle Beteiligten einen Vorgang gemeinsam bearbeiten können und nachvollziehbar bleibt, wer wann was getan hat.'],
  ['Wer verarbeitet', `Betreiber: ${operator}. Technische Dienstleister: Cloudflare (Speicherung in Rechenzentren in der EU) und Resend `
    + '(Versand von E-Mails, EU). Beide sind US-Unternehmen; die Datenübermittlung ist über ihre Datenschutzvereinbarungen abgesichert '
    + '(EU-Standardvertragsklauseln bzw. EU-US Data Privacy Framework).'],
  ['Wie lange', 'Bis zum Abschluss des Vorgangs und einer gegebenenfalls festgelegten Aufbewahrungsfrist; danach wird gelöscht.'],
  ['Daten anderer', 'Wenn Sie Dokumente, Nachrichten oder E-Mails mit Daten anderer Personen einstellen, sind Sie dafür verantwortlich, '
    + 'dass Sie das dürfen.'],
  ['Ihre Rechte', 'Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Beschwerde bei der Datenschutzaufsicht. '
    + 'Sie können die Einwilligung jederzeit im Konto widerrufen. Dann endet Ihr Zugang, und die Verantwortlichen führen Ihr Verfahren '
    + 'auf dem bisherigen Weg weiter. Der Widerruf gilt für die Zukunft.'],
  ['Kontakt', contact],
];

export const CONSENT_LABEL = 'Ich habe die Hinweise gelesen und willige ein, dass meine Daten wie beschrieben in NomoCase verarbeitet werden.';
