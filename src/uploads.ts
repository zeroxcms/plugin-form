// ============================================================
// File-upload question storage.
//
// Uploads from the PUBLIC form go straight to this plugin's own R2 bucket
// (the optional UPLOADS binding) — never to the host's /admin/upload, which
// requires an authenticated admin with `media:upload`. The stored answer is
// the R2 key; the admin downloads it back through the CMS-authenticated
// admin route (forms.ts `/forms/<id>/files/<key>`), so an attachment is
// never served from a public URL.
//
// Validation mirrors the host's src/security/media.ts posture: an extension
// allowlist with MIME consistency plus magic-byte sniffing, a canonical
// content type (never the client's), and a hard size cap. Script-capable
// formats (html, svg, xml) are absent from the allowlist by design.
// ============================================================

/** Hard ceiling regardless of a question's own `max_size`. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

interface AllowedType {
  /** Canonical MIME stored in R2 and served back. */
  contentType: string;
  /** Client-supplied MIME values accepted for this extension. */
  mimes: string[];
  /** Optional magic-byte validator over the first 16 bytes. */
  magic?: (bytes: Uint8Array) => boolean;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const isJpeg = (b: Uint8Array) => startsWith(b, [0xff, 0xd8, 0xff]);
const isPng = (b: Uint8Array) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
const isGif = (b: Uint8Array) => startsWith(b, [0x47, 0x49, 0x46, 0x38]);
const isWebp = (b: Uint8Array) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
const isIsoMedia = (b: Uint8Array) => startsWith(b, [0x66, 0x74, 0x79, 0x70], 4); // ....ftyp
const isPdf = (b: Uint8Array) => startsWith(b, [0x25, 0x50, 0x44, 0x46]); // %PDF
const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b]); // PK — also docx/xlsx/pptx

export const ALLOWED_UPLOAD_TYPES: Record<string, AllowedType> = {
  jpg: { contentType: 'image/jpeg', mimes: ['image/jpeg'], magic: isJpeg },
  jpeg: { contentType: 'image/jpeg', mimes: ['image/jpeg'], magic: isJpeg },
  png: { contentType: 'image/png', mimes: ['image/png'], magic: isPng },
  gif: { contentType: 'image/gif', mimes: ['image/gif'], magic: isGif },
  webp: { contentType: 'image/webp', mimes: ['image/webp'], magic: isWebp },
  avif: { contentType: 'image/avif', mimes: ['image/avif'], magic: isIsoMedia },
  pdf: { contentType: 'application/pdf', mimes: ['application/pdf'], magic: isPdf },
  txt: { contentType: 'text/plain', mimes: ['text/plain'] },
  csv: { contentType: 'text/csv', mimes: ['text/csv', 'application/vnd.ms-excel'] },
  zip: { contentType: 'application/zip', mimes: ['application/zip', 'application/x-zip-compressed'], magic: isZip },
  doc: { contentType: 'application/msword', mimes: ['application/msword'] },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    magic: isZip,
  },
  xls: { contentType: 'application/vnd.ms-excel', mimes: ['application/vnd.ms-excel'] },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    magic: isZip,
  },
  mp4: { contentType: 'video/mp4', mimes: ['video/mp4'], magic: isIsoMedia },
  mp3: { contentType: 'audio/mpeg', mimes: ['audio/mpeg', 'audio/mp3'] },
};

export type UploadValidation =
  | { ok: true; extension: string; contentType: string }
  | { ok: false; error: string };

/**
 * Validates one uploaded file against the size cap, the extension allowlist,
 * MIME consistency and magic bytes. `maxBytes` lets a question tighten (never
 * loosen) the global cap; `accept` limits it to specific extensions.
 */
export function validateUpload(
  file: File,
  headerBytes: Uint8Array,
  options: { maxBytes?: number; accept?: string } = {},
): UploadValidation {
  const limit = Math.min(options.maxBytes || MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  if (file.size > limit) {
    return { ok: false, error: `is larger than ${Math.round(limit / (1024 * 1024))} MB` };
  }
  if (file.size === 0) return { ok: false, error: 'is empty' };

  const extension = (file.name.split('.').pop() ?? '').toLowerCase();
  const allowed = ALLOWED_UPLOAD_TYPES[extension];
  if (!allowed) return { ok: false, error: `has an unsupported file type (.${extension || 'unknown'})` };

  const acceptedExtensions = parseAccept(options.accept);
  if (acceptedExtensions.length && !acceptedExtensions.includes(extension)) {
    return { ok: false, error: `must be one of: ${acceptedExtensions.map((ext) => `.${ext}`).join(', ')}` };
  }

  const clientMime = (file.type || '').toLowerCase();
  if (clientMime && !allowed.mimes.includes(clientMime)) {
    return { ok: false, error: 'does not match its file extension' };
  }
  if (allowed.magic && !allowed.magic(headerBytes)) {
    return { ok: false, error: 'is not a valid file of that type' };
  }
  return { ok: true, extension, contentType: allowed.contentType };
}

/** `.pdf,.docx` / `pdf, docx` → ['pdf','docx']. Empty means "any allowed type". */
export function parseAccept(accept: string | undefined): string[] {
  return (accept ?? '')
    .split(/[,\s]+/)
    .map((part) => part.trim().replace(/^\./, '').toLowerCase())
    .filter((part) => part in ALLOWED_UPLOAD_TYPES);
}

/**
 * Stores one validated upload and returns its R2 key. Keys are namespaced per
 * form (`form-<id>/…`) so the admin download route can prove a key belongs to
 * the form being viewed, and carry a random segment so a key is unguessable.
 */
export async function storeUpload(
  bucket: R2Bucket,
  formId: number,
  file: File,
  contentType: string,
): Promise<string> {
  const safeName = file.name.replace(/[^a-z0-9-_.]/gi, '').slice(-80) || 'upload';
  const key = `form-${formId}/${crypto.randomUUID()}-${safeName}`;
  await bucket.put(key, file.stream(), {
    httpMetadata: {
      contentType,
      // Attachments are always downloaded, never rendered in the admin's origin.
      contentDisposition: `attachment; filename="${safeName}"`,
    },
  });
  return key;
}

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
