// ============================================================
// File-upload answers — the admin's read side.
//
// The files themselves are written by worker-form, which validates a public
// upload (extension allowlist, MIME consistency, magic bytes, size cap — see
// worker-form/src/uploads.ts) and stores it in the shared UPLOADS bucket under
// `form-<id>/<uuid>-<name>`. The stored answer is that key.
//
// This plugin only reads the bucket back: an attachment is never public, and
// the only path to one is forms.ts `/forms/<id>/files/<key>`, which the host
// reaches with the plugin secret after authenticating the admin. The key
// layout is the contract between the two Workers — keep it in step.
// ============================================================

/** Display name of a stored key: the original filename after the uuid. */
export function uploadFileName(key: string): string {
  const base = key.split('/').pop() ?? key;
  // Keys are `<uuid>-<safeName>`; the uuid is 36 chars plus the dash.
  return base.length > 37 ? base.slice(37) : base;
}

/** True when the key belongs to this form (blocks traversal to another form's files). */
export function keyBelongsToForm(key: string, formId: number): boolean {
  return key.startsWith(`form-${formId}/`) && !key.includes('..');
}
