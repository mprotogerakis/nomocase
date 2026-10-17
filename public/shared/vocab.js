// Engine vocabulary shared by the Worker (src/) and the UI (public/): access levels and task types with behaviour.
export const STAFF = ['case_owner', 'case_editor'];
export const ACCESS = [...STAFF, 'guest_contributor', 'guest_viewer'];
export const TASK_TYPES = ['task', 'upload', 'review', 'approval', 'signature', 'submission', 'payment', 'reimbursement', 'decision', 'information', 'wait'];
export const DECISIONS = ['review', 'approval', 'decision'];
export const NEEDS_FILE = ['upload', 'signature']; // can only be completed by uploading through the task

// File kinds a step can restrict its uploads to (template "files": { "accept": ["pdf", …], "multiple": true }).
export const FILE_KINDS = { pdf: ['pdf'], image: ['png', 'jpg', 'jpeg'], word: ['docx', 'odt'], excel: ['xlsx'], text: ['txt'] };
export const FILE_KIND_LABELS = { pdf: 'PDF', image: 'Bilder (PNG, JPG)', word: 'Word/OpenDocument', excel: 'Excel', text: 'Text' };
// Extensions a step accepts (null: every allowed type).
export const acceptedExtensions = files => (files?.accept?.length ? files.accept.flatMap(k => FILE_KINDS[k] ?? []) : null);
// For the file input: accept=".pdf,.png" (empty: no restriction) and a short hint for the person uploading.
export const acceptAttr = files => (acceptedExtensions(files) ?? []).map(e => `.${e}`).join(',');
export const filesHint = files => [files?.accept?.length && `nur ${files.accept.map(k => FILE_KIND_LABELS[k]).join(' oder ')}`,
  files?.multiple && 'mehrere Dateien möglich'].filter(Boolean).join(' · ');
