// ============================================================
// Forms admin — plugin fragments rendered under the CMS admin chrome.
//
// Routes (proxied by the host from /admin/plugins/form/<rest> to this
// Worker's /__plugin/admin/<rest>):
//
//   GET  forms                      form index
//   GET  forms/new                  new-form panel
//   POST forms/new                  create form (seeds starter blocks)
//   GET  forms/:id                  form dashboard (link, fields, recent submissions)
//   POST forms/:id/status           open/close toggle
//   POST forms/:id/pull             pull new submissions (host ingest sweep)
//   GET  forms/:id/submissions      full submissions table
//   GET  forms/:id/export           submissions CSV
//   GET  forms/:id/delete           delete confirmation
//   POST forms/:id/delete           delete form + its submissions
//
// The form definition itself (blocks + custom inputs) is edited in the native
// CMS page editor — the manifest's blocks/blockLists give the editor its
// palette, mirroring how the events plugin's EDM/RSVP blocks are edited.
// ============================================================

import {
  CmsClient,
  PLUGIN_ID,
  attr,
  type CmsPage,
} from './cms';
import { allFormFields, answerColumns, formIsOpen, hasContactBlock, slugify, type AnswerColumn } from './fields';
import { SUBMISSION_PAGE_TYPE } from './submissions';
import { keyBelongsToForm, uploadFileName } from './uploads';
import { adminView, redirect } from '@lionrockjs/worker-cms-plugin';
import { type FormAdminAccess, forbidden } from './permissions';

export const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;

const SUBMISSIONS_PER_PAGE = 25;
const RECENT_SUBMISSIONS = 10;

export interface FormsEnv {
  VIEWS: Fetcher;
  PUBLIC_BASE_URL?: string;
  /** Attachment storage for file-upload questions (see src/uploads.ts). */
  UPLOADS?: R2Bucket;
}

export async function handleFormsAdmin(
  request: Request,
  cms: CmsClient,
  env: FormsEnv,
  segments: string[],
  url: URL,
  jsonOnly: boolean,
  access: FormAdminAccess,
): Promise<Response> {
  if (segments[0] === 'new') {
    if (!access.canEdit) return forbidden();
    if (request.method === 'POST') return createFormFromForm(request, cms);
    return newFormView(env.VIEWS, jsonOnly);
  }

  const formId = segments[0] ? Number(segments[0]) : null;
  const sub = segments[1] ?? '';

  if (formId && sub === 'status' && request.method === 'POST') {
    if (!access.canEdit) return forbidden();
    return toggleFormStatus(request, cms, formId);
  }
  if (formId && sub === 'pull' && request.method === 'POST') {
    if (!access.canEdit) return forbidden();
    return pullSubmissions(cms, formId, url);
  }
  if (formId && sub === 'submissions') {
    return submissionsView(cms, env, formId, url, jsonOnly, access);
  }
  if (formId && sub === 'export') {
    if (!access.canExport) return forbidden();
    return exportSubmissions(cms, formId);
  }
  if (formId && sub === 'files' && segments.length > 2) {
    return downloadFile(cms, env, formId, segments.slice(2).map(decodeURIComponent).join('/'));
  }
  if (formId && sub === 'delete') {
    if (!access.canDelete) return forbidden();
    if (request.method === 'POST') return deleteForm(cms, formId);
    return deleteFormView(cms, env.VIEWS, formId, jsonOnly);
  }
  if (formId) return formDashboard(cms, env, formId, url, jsonOnly, access);
  return formsList(cms, env.VIEWS, url, jsonOnly, access);
}

/**
 * Edit link into the CMS page editor that carries a `return_to` so the
 * editor's back arrow / Cancel button return to this plugin dashboard instead
 * of the CMS home (the CMS validates the path, only honouring /admin* targets).
 */
function editHrefReturningTo(pageId: number | string, returnTo: string): string {
  return `/admin/pages/${pageId}/edit?return_to=${encodeURIComponent(returnTo)}`;
}

function withFlash(path: string, message: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}flash=${encodeURIComponent(message)}`;
}

// ── Form index ────────────────────────────────────────────────────────────────

async function formsList(cms: CmsClient, views: Fetcher, url: URL, jsonOnly: boolean, access: FormAdminAccess): Promise<Response> {
  const { pages } = await cms.list('form', { limit: 200 });
  return adminView(views, 'Forms', 'forms', {
    flash: url.searchParams.get('flash') ?? '',
    canEdit: access.canEdit,
    canDelete: access.canDelete,
    newFormHref: access.canEdit ? `${ADMIN_BASE}/forms/new` : '',
    forms: pages.map((form) => ({
      id: form.id,
      name: form.name,
      open: formIsOpen(form.lect),
      updated: (form.updated_at ?? '').replace('T', ' ').slice(0, 16),
      dashboardHref: `${ADMIN_BASE}/forms/${form.id}`,
      editHref: access.canEdit ? editHrefReturningTo(form.id, `${ADMIN_BASE}/forms`) : '',
      deleteHref: access.canDelete ? `${ADMIN_BASE}/forms/${form.id}/delete` : '',
    })),
  }, jsonOnly);
}

// ── New form ──────────────────────────────────────────────────────────────────

function newFormView(views: Fetcher, jsonOnly: boolean): Promise<Response> {
  return adminView(views, 'New form', 'form-new', {
    backHref: `${ADMIN_BASE}/forms`,
    action: `${ADMIN_BASE}/forms/new`,
  }, jsonOnly);
}

async function createFormFromForm(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return redirect(`${ADMIN_BASE}/forms/new`);

  // A random slug suffix keeps public URLs unguessable-ish and collision-free
  // (the slug is the public /f/<slug> address).
  const suffix = crypto.getRandomValues(new Uint8Array(3)).reduce((out, byte) => out + byte.toString(16).padStart(2, '0'), '');
  const created = await cms.create({
    page_type: 'form',
    name,
    slug: `${slugify(name) || 'form'}-${suffix}`,
    lect: {
      _type: 'form',
      name: { mis: name },
      status: 'open',
      button_label: 'Submit',
      thankyou_heading: 'Thank you',
      thankyou_body: { mis: 'Your response has been recorded.' },
      // Starter blocks so the editor opens with a usable form: a contact
      // section plus one sample question (same block shapes the manifest
      // declares — the page editor takes over from here).
      _blocks: [
        {
          _id: 'contact',
          _type: 'form-contact',
          _weight: 1,
          title: { mis: 'Your details' },
          label_name: { mis: 'Name' },
          label_email: { mis: 'Email' },
          require_email: 'yes',
        },
        {
          _id: 'questions',
          _type: 'form-inputs',
          _weight: 2,
          title: { mis: 'Questions' },
          custom_input: [
            { name: 'question-1', type: 'text', required: 'no', label: { mis: 'Sample question' }, default_value: '' },
          ],
        },
      ],
    },
  });
  return redirect(editHrefReturningTo(created.id, `${ADMIN_BASE}/forms/${created.id}`));
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function formDashboard(
  cms: CmsClient,
  env: FormsEnv,
  formId: number,
  url: URL,
  jsonOnly: boolean,
  access: FormAdminAccess,
): Promise<Response> {
  const form = await cms.get(formId);
  if (form.page_type !== 'form') return notFound();

  // Public submissions land in the published DB. Pull and mirror them before
  // reading, so every dashboard visit reflects the latest responses. Keep this
  // best-effort: an unavailable ingest endpoint must not break the dashboard.
  try {
    await cms.ingestSubmissions();
  } catch (error) {
    console.error('[form-builder] dashboard submission refresh failed', error);
  }

  const { pages: submissions, total } = await cms.list(SUBMISSION_PAGE_TYPE, { parentId: formId, limit: RECENT_SUBMISSIONS });
  const fields = allFormFields(form);
  // The dashboard preview shows only the first few answer columns; the full
  // set (with every grid row) lives on the submissions page.
  const previewColumns = answerColumns(form).slice(0, 3);
  const open = formIsOpen(form.lect);

  return adminView(env.VIEWS, form.name, 'form-dashboard', {
    flash: url.searchParams.get('flash') ?? '',
    formName: form.name,
    open,
    formsHref: `${ADMIN_BASE}/forms`,
    editHref: access.canEdit ? editHrefReturningTo(formId, `${ADMIN_BASE}/forms/${formId}`) : '',
    deleteHref: access.canDelete ? `${ADMIN_BASE}/forms/${formId}/delete` : '',
    statusAction: access.canEdit ? `${ADMIN_BASE}/forms/${formId}/status` : '',
    nextStatus: open ? 'closed' : 'open',
    statusLabel: open ? 'Close form' : 'Reopen form',
    publicUrl: publicFormUrl(env, form),
    hasContact: hasContactBlock(form),
    fields: fields.map((field) => ({
      label: field.label,
      name: field.name,
      type: field.type,
      required: field.required,
    })),
    submissionsTotal: total,
    submissionsHref: `${ADMIN_BASE}/forms/${formId}/submissions`,
    exportHref: access.canExport && total > 0 ? `${ADMIN_BASE}/forms/${formId}/export` : '',
    pullAction: access.canEdit ? `${ADMIN_BASE}/forms/${formId}/pull` : '',
    recentSubmissions: submissions.map((submission) => submissionRow(submission, previewColumns, formId)),
    recentColumns: previewColumns.map((column) => column.label),
  }, jsonOnly);
}

function publicFormUrl(env: FormsEnv, form: CmsPage): string {
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const ref = form.slug || String(form.id);
  return base ? `${base}/f/${ref}` : `/f/${ref}`;
}

async function toggleFormStatus(request: Request, cms: CmsClient, formId: number): Promise<Response> {
  const form = await request.formData();
  const status = String(form.get('status') ?? '').trim().toLowerCase() === 'closed' ? 'closed' : 'open';
  const page = await cms.get(formId);
  if (page.page_type !== 'form') return notFound();
  await cms.update(formId, { lect: { status } });
  return redirect(withFlash(`${ADMIN_BASE}/forms/${formId}`, status === 'closed' ? 'Form closed.' : 'Form reopened.'));
}

async function pullSubmissions(cms: CmsClient, formId: number, url: URL): Promise<Response> {
  // The host ingest is bounded per call; keep sweeping while it reports more,
  // within a small budget so this POST stays snappy.
  let created = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const result = await cms.ingestSubmissions();
    created += result.created;
    if (!result.more) break;
  }
  const back = url.searchParams.get('return_to') === 'submissions'
    ? `${ADMIN_BASE}/forms/${formId}/submissions`
    : `${ADMIN_BASE}/forms/${formId}`;
  return redirect(withFlash(back, created ? `${created} new submission(s) pulled.` : 'No new submissions.'));
}

// ── Submissions ───────────────────────────────────────────────────────────────

function submissionAnswers(submission: CmsPage): Record<string, string> {
  const value = submission.lect.answers;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** One table cell: plain text, or a download link for a stored upload. */
interface SubmissionCell {
  text: string;
  href: string;
}

function submissionRow(submission: CmsPage, columns: AnswerColumn[], formId: number): Record<string, unknown> {
  const answers = submissionAnswers(submission);
  return {
    id: submission.id,
    name: attr(submission.lect, 'name') || submission.name,
    email: attr(submission.lect, 'email'),
    submittedAt: attr(submission.lect, 'submitted_at').replace('T', ' ').slice(0, 16),
    values: columns.map((column): SubmissionCell => {
      const value = answers[column.name] ?? '';
      if (!column.isFile || !value) return { text: value, href: '' };
      return { text: uploadFileName(value), href: fileHref(formId, value) };
    }),
  };
}

/**
 * Columns for the submissions table / CSV: the form's current questions first
 * (grid questions expand to one column per row), then any stored answer keys
 * the definition no longer carries, so answers to edited or removed questions
 * stay visible.
 */
function submissionColumns(form: CmsPage, submissions: CmsPage[]): AnswerColumn[] {
  const columns = answerColumns(form);
  const known = new Set(columns.map((column) => column.name));
  for (const submission of submissions) {
    for (const key of Object.keys(submissionAnswers(submission))) {
      if (known.has(key)) continue;
      known.add(key);
      columns.push({
        name: key,
        label: key.replace(/^form-/, '').replace(/__/g, ' — ').replace(/[-_]/g, ' '),
        isFile: false,
      });
    }
  }
  return columns;
}

/** Admin-only download URL for a stored upload (proxied through the host). */
function fileHref(formId: number, key: string): string {
  return `${ADMIN_BASE}/forms/${formId}/files/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Streams one stored upload back to the signed-in admin. Attachments are never
 * public: the only path to them is this route, which the host reaches with the
 * plugin secret after authenticating the admin. The key must live under this
 * form's prefix, so a crafted key cannot reach another form's files.
 */
async function downloadFile(cms: CmsClient, env: FormsEnv, formId: number, key: string): Promise<Response> {
  const form = await cms.get(formId);
  if (form.page_type !== 'form') return notFound();
  if (!env.UPLOADS || !keyBelongsToForm(key, formId)) return notFound();

  const object = await env.UPLOADS.get(key);
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-disposition', `attachment; filename="${uploadFileName(key).replace(/"/g, '')}"`);
  headers.set('cache-control', 'private, no-store');
  // Uploaded bytes are attacker-supplied; never let a browser sniff them into
  // an executable type on the admin origin.
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}

async function submissionsView(
  cms: CmsClient,
  env: FormsEnv,
  formId: number,
  url: URL,
  jsonOnly: boolean,
  access: FormAdminAccess,
): Promise<Response> {
  const form = await cms.get(formId);
  if (form.page_type !== 'form') return notFound();

  const { pages: submissions, total } = await cms.list(SUBMISSION_PAGE_TYPE, { parentId: formId, limit: 500 });
  const columns = submissionColumns(form, submissions);

  const totalPages = Math.max(1, Math.ceil(submissions.length / SUBMISSIONS_PER_PAGE));
  const page = Math.min(parsePositiveInt(url.searchParams.get('page')) ?? 1, totalPages);
  const start = (page - 1) * SUBMISSIONS_PER_PAGE;
  const paged = submissions.slice(start, start + SUBMISSIONS_PER_PAGE);

  return adminView(env.VIEWS, `Submissions — ${form.name}`, 'form-submissions', {
    flash: url.searchParams.get('flash') ?? '',
    formName: form.name,
    backHref: `${ADMIN_BASE}/forms/${formId}`,
    exportHref: access.canExport && total > 0 ? `${ADMIN_BASE}/forms/${formId}/export` : '',
    pullAction: access.canEdit ? `${ADMIN_BASE}/forms/${formId}/pull?return_to=submissions` : '',
    columns: columns.map((column) => column.label),
    submissions: paged.map((submission) => submissionRow(submission, columns, formId)),
    total,
    page,
    totalPages,
    rangeStart: submissions.length > 0 ? start + 1 : 0,
    rangeEnd: Math.min(start + SUBMISSIONS_PER_PAGE, submissions.length),
    prevHref: page > 1 ? submissionsPageHref(formId, page - 1) : '',
    nextHref: page < totalPages ? submissionsPageHref(formId, page + 1) : '',
  }, jsonOnly);
}

function submissionsPageHref(formId: number, page: number): string {
  return page <= 1
    ? `${ADMIN_BASE}/forms/${formId}/submissions`
    : `${ADMIN_BASE}/forms/${formId}/submissions?page=${page}`;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function exportSubmissions(cms: CmsClient, formId: number): Promise<Response> {
  const form = await cms.get(formId);
  if (form.page_type !== 'form') return notFound();

  const { pages: submissions } = await cms.list(SUBMISSION_PAGE_TYPE, { parentId: formId, limit: 500 });
  const columns = submissionColumns(form, submissions);
  const headers = ['name', 'email', 'submitted_at', 'language', ...columns.map((column) => column.label)];
  const rows = submissions.map((submission) => {
    const answers = submissionAnswers(submission);
    return [
      attr(submission.lect, 'name') || submission.name,
      attr(submission.lect, 'email'),
      attr(submission.lect, 'submitted_at'),
      attr(submission.lect, 'language'),
      // File answers export as their original filename — the raw R2 key is an
      // internal storage detail, and the file itself is admin-only anyway.
      ...columns.map((column) => {
        const value = answers[column.name] ?? '';
        return column.isFile && value ? uploadFileName(value) : value;
      }),
    ];
  });

  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  // UTF-8 BOM so Excel opens non-ASCII answers correctly.
  return new Response('\ufeff' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="form-${formId}-submissions.csv"`,
      'cache-control': 'no-store',
    },
  });
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteFormView(cms: CmsClient, views: Fetcher, formId: number, jsonOnly: boolean): Promise<Response> {
  const form = await cms.get(formId);
  if (form.page_type !== 'form') return notFound();
  const { total } = await cms.list(SUBMISSION_PAGE_TYPE, { parentId: formId, limit: 1 });
  return adminView(views, `Delete — ${form.name}`, 'form-delete', {
    formName: form.name,
    backHref: `${ADMIN_BASE}/forms/${formId}`,
    action: `${ADMIN_BASE}/forms/${formId}/delete`,
    submissionCount: total,
  }, jsonOnly);
}

async function deleteForm(cms: CmsClient, formId: number): Promise<Response> {
  const form = await cms.get(formId);
  if (form.page_type !== 'form') return notFound();
  // Submission mirrors hang off the form by parent page id. Trash them
  // server-side (bounded slices in the CMS Worker), then the form itself.
  await cms.deleteChildren({ parentPageId: formId }, SUBMISSION_PAGE_TYPE);
  await cms.remove(formId);
  return redirect(withFlash(`${ADMIN_BASE}/forms`, 'Form deleted.'));
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
}
