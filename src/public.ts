// ============================================================
// Public form site — /f/<slug-or-id> on this Worker's own domain.
//
// Follows the worker-rsvp posture: published-D1 reads only on GET, no
// cookies or sessions, and the submit path writes INSERT-only
// form_submission rows into the published D1 (src/submissions.ts) — it never
// calls the Plugin API. worker-cms ingests the rows into its draft DB on a
// cron (or when the admin pulls) and fires `submission` hooks.
//
// File-upload answers are the one thing that does not live in the row: the
// file goes to this plugin's own R2 bucket (src/uploads.ts) and the answer
// stores its key, which only the authenticated admin can resolve back to a
// download.
// ============================================================

import { attr, localized, type CmsPage } from './cms';
import {
  collectAnswers,
  contactEmailRequired,
  formBlockVMs,
  formIsOpen,
  hasContactBlock,
  hasFileQuestion,
  missingRequiredFields,
  allFormFields,
  type FormFieldVM,
} from './fields';
import { getPublishedPage, getPublishedPageBySlug, type PublishedEnv } from './published';
import { insertFormSubmission } from './submissions';
import { renderLiquid, safeHtml } from './templates/liquid';
import { storeUpload, validateUpload } from './uploads';

export interface PublicEnv extends PublishedEnv {
  VIEWS: Fetcher;
  /** Base URL of the CMS Worker — used only to absolutize /media asset paths. */
  CMS_URL?: string;
  /** Attachment storage for file-upload questions. Unbound → those questions
   *  are shown disabled, and the rest of the form still works. */
  UPLOADS?: R2Bucket;
}

const DEFAULT_LANGUAGE = 'mis';

export async function handlePublicForm(request: Request, env: PublicEnv, url: URL): Promise<Response | null> {
  const path = url.pathname.split('/').filter(Boolean);
  if (path[0] !== 'f' || !path[1] || path.length > 2) return null;
  if (!env.PUBLISHED_DB) return new Response('server misconfigured', { status: 500 });

  const form = await getPublishedFormByRef(env.PUBLISHED_DB, path[1]);
  if (!form) return new Response('not found', { status: 404 });

  const language = url.searchParams.get('lang') || DEFAULT_LANGUAGE;

  if (request.method === 'POST') return submitForm(request, env, url, form, language);

  if (url.searchParams.has('thank-you')) return thankYou(env, form, language);
  if (!formIsOpen(form.lect)) return closedForm(env, form, language);
  return htmlResponse(await renderForm(env, url, form, language));
}

async function getPublishedFormByRef(db: D1Database, ref: string): Promise<CmsPage | null> {
  const value = ref.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const page = await getPublishedPage(db, Number(value));
    if (page?.page_type === 'form') return page;
  }
  const page = await getPublishedPageBySlug(db, 'form', value);
  return page?.page_type === 'form' ? page : null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

interface RenderOptions {
  error?: string;
  answers?: Record<string, string>;
  contactName?: string;
  contactEmail?: string;
}

async function renderForm(
  env: PublicEnv,
  url: URL,
  form: CmsPage,
  language: string,
  options: RenderOptions = {},
): Promise<string> {
  const answers = options.answers ?? {};
  const uploadsReady = !!env.UPLOADS;
  const blocks = formBlockVMs(form, language, safeHtml, answers).map((block) => {
    if (block.type === 'picture') return { ...block, src: assetUrl(env.CMS_URL, String(block.src ?? '')) };
    if (block.type === 'form-contact') {
      return { ...block, nameValue: options.contactName ?? '', emailValue: options.contactEmail ?? '' };
    }
    if (block.type === 'form-inputs') {
      // A file question with no bucket bound must not look answerable.
      const inputs = (block.inputs as FormFieldVM[]).map((input) => ({
        ...input,
        disabled: input.type === 'file' && !uploadsReady,
        acceptAttr: input.accept ? input.accept.split(/[,\s]+/).filter(Boolean).map((ext) => `.${ext.replace(/^\./, '')}`).join(',') : '',
      }));
      return { ...block, inputs };
    }
    return block;
  });

  return renderLiquid(env.VIEWS, '/templates/public-form.liquid', {
    language,
    formName: localized(form.lect, 'name', language) || form.name,
    description: localized(form.lect, 'description', language),
    featuredImage: assetUrl(env.CMS_URL, attr(form.lect, 'featured_image')),
    action: url.pathname,
    // Files can only be posted as multipart; only ask for it when needed so
    // ordinary forms keep the cheaper urlencoded body.
    multipart: hasFileQuestion(form, language) && uploadsReady,
    error: options.error ?? '',
    blocks,
    buttonLabel: localized(form.lect, 'button_label', language) || attr(form.lect, 'button_label') || 'Submit',
  });
}

async function thankYou(env: PublicEnv, form: CmsPage, language: string): Promise<Response> {
  const html = await renderLiquid(env.VIEWS, '/templates/public-thank-you.liquid', {
    formName: localized(form.lect, 'name', language) || form.name,
    title: localized(form.lect, 'thankyou_heading', language) || 'Thank you',
    bodyHtml: safeHtml(localized(form.lect, 'thankyou_body', language)) || 'Your response has been recorded.',
    closed: false,
  });
  return htmlResponse(html);
}

async function closedForm(env: PublicEnv, form: CmsPage, language: string): Promise<Response> {
  const html = await renderLiquid(env.VIEWS, '/templates/public-thank-you.liquid', {
    formName: localized(form.lect, 'name', language) || form.name,
    title: localized(form.lect, 'name', language) || form.name,
    bodyHtml: 'This form is no longer accepting responses.',
    closed: true,
  });
  return htmlResponse(html);
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitForm(
  request: Request,
  env: PublicEnv,
  url: URL,
  form: CmsPage,
  language: string,
): Promise<Response> {
  if (!formIsOpen(form.lect)) return closedForm(env, form, language);

  const data = await request.formData();
  // Classic honeypot: a visually hidden "website" input real visitors never
  // fill. Pretend success, store nothing.
  if (String(data.get('website') ?? '').trim() !== '') return thankYouRedirect(url);

  const answers = collectAnswers(data);
  const contactName = String(data.get('contact-name') ?? '').trim();
  const contactEmail = String(data.get('contact-email') ?? '').trim();

  const problems: string[] = [];
  if (hasContactBlock(form)) {
    if (!contactName) problems.push('Name is required.');
    if (contactEmailRequired(form) && !contactEmail) problems.push('Email is required.');
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) problems.push('Enter a valid email address.');
  }

  // Uploads are validated and stored BEFORE the required-field check, so a
  // rejected file reads as "missing" rather than silently passing validation.
  problems.push(...await applyUploads(env, form, language, data, answers));

  const missing = missingRequiredFields(form, language, answers);
  if (missing.length) {
    problems.push(`Please answer: ${missing.map((field) => field.label).join(', ')}.`);
  }
  if (problems.length) {
    const html = await renderForm(env, url, form, language, {
      error: problems.join(' '),
      answers,
      contactName,
      contactEmail,
    });
    return htmlResponse(html, 400);
  }

  await insertFormSubmission(env.PUBLISHED_DB!, {
    form,
    name: contactName,
    email: contactEmail,
    language,
    answers,
  });
  return thankYouRedirect(url);
}

/**
 * Validates and stores every file-upload answer, writing each resulting R2
 * key into `answers`. Returns human-readable problems for rejected files;
 * a question whose upload failed is left unanswered so `required` still bites.
 */
async function applyUploads(
  env: PublicEnv,
  form: CmsPage,
  language: string,
  data: FormData,
  answers: Record<string, string>,
): Promise<string[]> {
  const fileFields = allFormFields(form, language).filter((field) => field.type === 'file');
  if (!fileFields.length) return [];

  const problems: string[] = [];
  for (const field of fileFields) {
    // A file input never contributes a usable string answer; drop whatever
    // the browser posted so a filename can't masquerade as a stored key.
    delete answers[field.name];

    const value = data.get(field.name);
    if (!(value instanceof File) || !value.name || value.size === 0) continue;
    if (!env.UPLOADS) {
      problems.push(`${field.label}: file uploads are not available right now.`);
      continue;
    }

    const header = new Uint8Array(await value.slice(0, 16).arrayBuffer());
    const validation = validateUpload(value, header, {
      maxBytes: field.maxSizeMb ? field.maxSizeMb * 1024 * 1024 : undefined,
      accept: field.accept,
    });
    if (!validation.ok) {
      problems.push(`${field.label}: the file ${validation.error}.`);
      continue;
    }
    answers[field.name] = await storeUpload(env.UPLOADS, form.id, value, validation.contentType);
  }
  return problems;
}

function thankYouRedirect(url: URL): Response {
  const target = new URL(url);
  target.searchParams.set('thank-you', '1');
  return new Response(null, { status: 303, headers: { Location: target.toString() } });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function assetUrl(base: string | undefined, value: string): string {
  const src = value.trim();
  if (!src) return '';
  if (src.startsWith('/media/')) return src;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  const origin = (base ?? '').replace(/\/+$/, '');
  return origin && src.startsWith('/') ? `${origin}${src}` : src;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
