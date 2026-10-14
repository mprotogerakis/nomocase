// Engine vocabulary shared by the Worker (src/) and the UI (public/): access levels and task types with behaviour.
export const STAFF = ['case_owner', 'case_editor'];
export const ACCESS = [...STAFF, 'guest_contributor', 'guest_viewer'];
export const TASK_TYPES = ['task', 'upload', 'review', 'approval', 'signature', 'submission', 'payment', 'reimbursement', 'decision', 'information', 'wait'];
export const DECISIONS = ['review', 'approval', 'decision'];
export const NEEDS_FILE = ['upload', 'signature']; // can only be completed by uploading through the task
