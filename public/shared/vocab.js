// Engine vocabulary shared by the Worker (src/) and the UI (public/): access levels and task types with behaviour.
export const STAFF = ['case_owner', 'case_editor'];
export const ACCESS = [...STAFF, 'guest_contributor', 'guest_viewer'];
export const TASK_TYPES = ['task', 'upload', 'review', 'approval', 'signature', 'submission', 'payment', 'reimbursement', 'decision', 'information', 'wait'];
export const DECISIONS = ['review', 'approval', 'decision'];
export const NEEDS_FILE = ['upload', 'signature']; // can only be completed by uploading through the task

// Rules in plain words (case view, template editor). Amount facts are cents.
export const RULE_TRIGGER_LABELS = {
  'task.complete': 'eine Aufgabe erledigt wird', 'task.approve': 'eine Prüfung oder Entscheidung positiv ausfällt',
  'task.reject': 'eine Prüfung oder Entscheidung negativ ausfällt', 'task.question': 'eine Rückfrage gestellt wird',
  'document.uploaded': 'ein Dokument hochgeladen wird', 'request.created': 'ein Anliegen eingereicht wird', comment: 'eine Nachricht geschrieben wird',
  'signature.changed': 'jemand mit einem anderen Schlüssel als bisher signiert', 'form.mismatch': 'ein hochgeladenes Formular von den Angaben abweicht',
  'claim.added': 'eine Forderung erfasst wird', 'decision.added': 'eine Entscheidung erfasst wird', 'transaction.booked': 'eine Zahlung gebucht wird',
  'case.closed': 'der Vorgang abgeschlossen wird', 'participant.joined': 'jemand dem Vorgang beitritt', 'subcase.closed': 'ein Teilvorgang abgeschlossen wird',
};
export const RULE_FIELD_LABELS = {
  'task.key': 'Aufgabe', 'task.title': 'Aufgabentitel', 'task.type': 'Aufgabentyp', 'task.role': 'zuständige Rolle', 'task.outcome': 'Ergebnis',
  'document.type': 'Dokumenttyp', 'document.title': 'Dokument', 'document.filename': 'Dateiname', 'event.actor_role': 'Rolle der handelnden Person',
  'comment.text': 'Nachricht', 'case.title': 'Titel des Vorgangs', 'subcase.title': 'Teilvorgang', 'subcase.template': 'Vorlage des Teilvorgangs',
  'claim.title': 'Forderung', 'claim.direction': 'Art', 'claim.amount': 'Betrag', 'claim.recognized': 'anerkannt', 'claim.cut': 'Kürzung',
  'claim.settled': 'gezahlt', 'claim.open': 'offener Betrag', 'case.payables_open': 'offene Rechnungen', 'case.receivables_open': 'offen zu erhalten',
};
export const RULE_MONEY_FIELDS = ['claim.amount', 'claim.recognized', 'claim.cut', 'claim.settled', 'claim.open', 'case.payables_open', 'case.receivables_open'];
export const RULE_OP_LABELS = { equals: '=', not_equals: '≠', greater_than: '>', less_than: '<', contains: 'enthält', in: 'ist eines von' };
export const RULE_ACTION_LABELS = { add_comment: 'Nachricht schreiben', create_task: 'Aufgabe anlegen', complete_tasks: 'Aufgabe abhaken',
  create_subcase: 'Teilvorgang anlegen' };

// File kinds a step can restrict its uploads to (template "files": { "accept": ["pdf", …], "multiple": true }).
export const FILE_KINDS = { pdf: ['pdf'], image: ['png', 'jpg', 'jpeg'], word: ['docx', 'odt'], excel: ['xlsx'], text: ['txt'] };
export const FILE_KIND_LABELS = { pdf: 'PDF', image: 'Bilder (PNG, JPG)', word: 'Word/OpenDocument', excel: 'Excel', text: 'Text' };
// A valid "files" setting (template or a step changed in a case).
export const validFiles = f => !!f && typeof f === 'object' && !Array.isArray(f) && (f.multiple === undefined || typeof f.multiple === 'boolean')
  && (f.accept === undefined || (Array.isArray(f.accept) && f.accept.every(k => FILE_KINDS[k])));
// Extensions a step accepts (null: every allowed type).
export const acceptedExtensions = files => (files?.accept?.length ? files.accept.flatMap(k => FILE_KINDS[k] ?? []) : null);
// For the file input: accept=".pdf,.png" (empty: no restriction) and a short hint for the person uploading.
export const acceptAttr = files => (acceptedExtensions(files) ?? []).map(e => `.${e}`).join(',');
export const filesHint = files => [files?.accept?.length && `nur ${files.accept.map(k => FILE_KIND_LABELS[k]).join(' oder ')}`,
  files?.multiple && 'mehrere Dateien möglich'].filter(Boolean).join(' · ');
