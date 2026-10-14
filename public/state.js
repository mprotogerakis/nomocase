// App-wide state and the handler registries. Importers cannot assign module bindings, so state changes go through set().

export let me = null; // GET /api/me

export let cur = null; // currently open case payload

export let stamp = null; // change stamp of the shown case or overview (live updates)

export let templates = [];
export const set = values => ({ me, cur, stamp, templates } = { me, cur, stamp, templates, ...values });

// Event delegation: data-on (click), data-submit (forms), data-change (inputs).
export const on = {}, submit = {}, change = {};
