// ============================================================
// Form field projection — the single source of truth shared by all three
// surfaces: the editor (question cards), the public renderer, and the
// answer columns used by the submissions table and CSV export.
//
// A form page's fields live in its `_blocks`: `form-inputs` blocks carry a
// `custom_input` item list (the shape ported from the events plugin's
// rsvp-custom block), and an optional `form-contact` block collects the
// submitter's name/email. Public form fields are named `form-<name-slug>`
// (the legacy custom-input naming scheme with this plugin's prefix), so
// answers survive label edits when an explicit `name` is set.
//
// Question types mirror Google Forms. Types that collect ONE value per
// question store one answer under the field name; grid types store one
// answer per row under `<field>__<row-slug>`, and multi-select types join
// their chosen values with ", " so an answer map stays flat (string→string).
// ============================================================

import { attr, blocks, items, localized, type CmsPage } from './cms';

/** Prefix of every custom-input form field, and of every stored answer key. */
export const FIELD_PREFIX = 'form-';

/** Separator between a grid question's field name and its row slug. */
const ROW_SEPARATOR = '__';

/** Joins the values of a multi-select answer inside one answer string. */
export const MULTI_VALUE_SEPARATOR = ', ';

/** Question types, labeled as in Google Forms. Order drives the editor menu. */
export const QUESTION_TYPES: Array<{ value: string; label: string }> = [
  { value: 'text', label: 'Short answer' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'radio', label: 'Multiple choice' },
  { value: 'checkboxes', label: 'Checkboxes' },
  { value: 'select', label: 'Dropdown' },
  { value: 'file', label: 'File upload' },
  { value: 'scale', label: 'Linear scale' },
  { value: 'rating', label: 'Rating' },
  { value: 'grid-radio', label: 'Multiple choice grid' },
  { value: 'grid-checkbox', label: 'Checkbox grid' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'url', label: 'URL' },
  { value: 'tel', label: 'Phone' },
  { value: 'checkbox', label: 'Single checkbox' },
];

/** Types whose options come from `default_value` (one per line). */
export const CHOICE_TYPES = new Set(['radio', 'checkboxes', 'select', 'grid-radio', 'grid-checkbox']);
/** Types laid out as a row × column matrix. */
export const GRID_TYPES = new Set(['grid-radio', 'grid-checkbox']);
/** Types that can collect several values for one question (or grid row). */
export const MULTI_VALUE_TYPES = new Set(['checkboxes', 'grid-checkbox']);

const SCALE_DEFAULT_MIN = 1;
const SCALE_DEFAULT_MAX = 5;
const RATING_DEFAULT_MAX = 5;
/** Rating/scale bounds are rendered as individual controls — keep them sane. */
const SCALE_LIMIT = 20;

export interface FormFieldOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface FormFieldRow {
  /** Row label shown beside the matrix row. */
  label: string;
  /** Form field name for this row: `<field><ROW_SEPARATOR><row-slug>`. */
  name: string;
  /** Column options with this row's stored answer applied. */
  options: FormFieldOption[];
}

export interface FormFieldVM {
  /** Full public form field name (`form-<slug>`), also the stored answer key. */
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: string;
  value: string;
  checked: boolean;
  options: FormFieldOption[];
  /** Matrix rows (grid types only). */
  rows: FormFieldRow[];
  /** Linear-scale points, and the labels shown at either end. */
  scalePoints: FormFieldOption[];
  minLabel: string;
  maxLabel: string;
  /** Rating stars in DESCENDING order (the CSS-only fill rule needs that). */
  stars: Array<{ value: string; selected: boolean }>;
  /** File upload constraints. */
  accept: string;
  maxSizeMb: number;
}

export interface FormBlockVM {
  type: string;
  title: string;
  bodyHtml: string;
  [key: string]: unknown;
}

/** One column of the submissions table / CSV export. */
export interface AnswerColumn {
  name: string;
  label: string;
  /** True when the stored answer is an uploaded file key. */
  isFile: boolean;
}

/** A form is open unless its `status` attr says otherwise. */
export function formIsOpen(lect: Record<string, unknown>): boolean {
  const status = attr(lect, 'status').trim().toLowerCase();
  return status === '' || status === 'open';
}

/**
 * Projects the form page's blocks into the flat shapes the public template
 * renders. `bodyHtml` values must be sanitised by the caller (safeHtml) —
 * this module is renderer-agnostic.
 */
export function formBlockVMs(
  form: CmsPage,
  language: string,
  sanitize: (html: string) => string,
  answers: Record<string, string> = {},
): FormBlockVM[] {
  const vms: FormBlockVM[] = [];
  for (const block of blocks(form.lect)) {
    const type = attr(block, '_type');
    const title = localized(block, 'title', language);
    const bodyHtml = sanitize(localized(block, 'body', language));
    switch (type) {
      case 'paragraph':
        vms.push({ type, title: '', bodyHtml, subject: localized(block, 'subject', language) });
        break;
      case 'picture': {
        const src = localized(block, 'picture', language) || attr(block, 'picture');
        if (src) {
          vms.push({
            type,
            title: '',
            bodyHtml: '',
            src,
            caption: localized(block, 'caption', language) || attr(block, 'caption'),
            width: attr(block, 'width'),
            align: attr(block, 'align'),
          });
        }
        break;
      }
      case 'form-contact':
        vms.push({
          type,
          title,
          bodyHtml,
          nameLabel: localized(block, 'label_name', language) || 'Name',
          emailLabel: localized(block, 'label_email', language) || 'Email',
          requireEmail: truthy(attr(block, 'require_email')),
          nameValue: answers['contact-name'] ?? '',
          emailValue: answers['contact-email'] ?? '',
        });
        break;
      case 'form-inputs':
        vms.push({ type, title, bodyHtml, inputs: customInputVMs(block, language, answers) });
        break;
      default:
        break;
    }
  }
  return vms;
}

/** Legacy field-name scheme: `form-<name-or-label slug>` (lowercased, spaces → dashes). */
export function customInputVMs(
  block: Record<string, unknown>,
  language: string,
  answers: Record<string, string> = {},
): FormFieldVM[] {
  return items(block, 'custom_input')
    .map((input) => {
      const label = localized(input, 'label', language);
      const name = attr(input, 'name') || slugify(label);
      const type = normalizeType(attr(input, 'type'));
      // Localized first — options are translatable; a plain string (legacy
      // data, or an untranslated field) reads back unchanged through localized().
      const defaultValue = localized(input, 'default_value', language) || attr(input, 'default_value');
      const fieldName = `${FIELD_PREFIX}${slugify(name)}`;
      const value = answers[fieldName] ?? '';
      const chosen = new Set(splitAnswer(value));

      return {
        name: fieldName,
        label,
        type,
        required: truthy(attr(input, 'required')),
        defaultValue,
        value,
        checked: Object.hasOwn(answers, fieldName),
        options: CHOICE_TYPES.has(type)
          ? parseOptions(defaultValue).map((option) => ({ ...option, selected: chosen.has(option.value) }))
          : [],
        rows: GRID_TYPES.has(type) ? gridRows(input, fieldName, defaultValue, language, answers) : [],
        scalePoints: type === 'scale' ? scalePoints(input, value) : [],
        minLabel: localized(input, 'min_label', language) || attr(input, 'min_label'),
        maxLabel: localized(input, 'max_label', language) || attr(input, 'max_label'),
        stars: type === 'rating' ? ratingStars(input, value) : [],
        accept: attr(input, 'accept'),
        maxSizeMb: positiveInt(attr(input, 'max_size')) ?? 0,
      };
    })
    .filter((input) => input.label);
}

/** Matrix rows for a grid question — one form field per row. */
function gridRows(
  input: Record<string, unknown>,
  fieldName: string,
  defaultValue: string,
  language: string,
  answers: Record<string, string>,
): FormFieldRow[] {
  const columns = parseOptions(defaultValue);
  return parseLines(localized(input, 'rows', language) || attr(input, 'rows')).map((rowLabel) => {
    const name = `${fieldName}${ROW_SEPARATOR}${slugify(rowLabel)}`;
    const chosen = new Set(splitAnswer(answers[name] ?? ''));
    return {
      label: rowLabel,
      name,
      options: columns.map((column) => ({ ...column, selected: chosen.has(column.value) })),
    };
  });
}

function scalePoints(input: Record<string, unknown>, value: string): FormFieldOption[] {
  const min = positiveOrZeroInt(attr(input, 'min')) ?? SCALE_DEFAULT_MIN;
  const max = positiveOrZeroInt(attr(input, 'max')) ?? SCALE_DEFAULT_MAX;
  const points: FormFieldOption[] = [];
  for (let point = min; point <= max && points.length < SCALE_LIMIT; point += 1) {
    points.push({ value: String(point), label: String(point), selected: value === String(point) });
  }
  return points;
}

/** Descending, so the CSS-only star fill rule (`input:checked ~ label`) works. */
function ratingStars(input: Record<string, unknown>, value: string): Array<{ value: string; selected: boolean }> {
  const max = Math.min(positiveInt(attr(input, 'max')) ?? RATING_DEFAULT_MAX, SCALE_LIMIT);
  const stars: Array<{ value: string; selected: boolean }> = [];
  for (let star = max; star >= 1; star -= 1) {
    stars.push({ value: String(star), selected: value === String(star) });
  }
  return stars;
}

/** Flat list of every custom input across all form-inputs blocks. */
export function allFormFields(form: CmsPage, language = 'mis'): FormFieldVM[] {
  const fields: FormFieldVM[] = [];
  const seen = new Set<string>();
  for (const block of blocks(form.lect)) {
    if (attr(block, '_type') !== 'form-inputs') continue;
    for (const field of customInputVMs(block, language)) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Columns for the submissions table and CSV: one per single-value question,
 * one per ROW for grid questions (a grid stores an answer per row, so a
 * single column could never show it).
 */
export function answerColumns(form: CmsPage, language = 'mis'): AnswerColumn[] {
  const columns: AnswerColumn[] = [];
  for (const field of allFormFields(form, language)) {
    if (GRID_TYPES.has(field.type) && field.rows.length) {
      for (const row of field.rows) {
        columns.push({ name: row.name, label: `${field.label} — ${row.label}`, isFile: false });
      }
      continue;
    }
    columns.push({ name: field.name, label: field.label, isFile: field.type === 'file' });
  }
  return columns;
}

/** True when any block collects the submitter's contact details. */
export function hasContactBlock(form: CmsPage): boolean {
  return blocks(form.lect).some((block) => attr(block, '_type') === 'form-contact');
}

/** Whether the contact block (if any) marks email as required. */
export function contactEmailRequired(form: CmsPage): boolean {
  return blocks(form.lect).some(
    (block) => attr(block, '_type') === 'form-contact' && truthy(attr(block, 'require_email')),
  );
}

/** True when the form has at least one file-upload question. */
export function hasFileQuestion(form: CmsPage, language = 'mis'): boolean {
  return allFormFields(form, language).some((field) => field.type === 'file');
}

/**
 * Custom-input answers from a public submit, verbatim. Only `form-*` fields
 * qualify — everything else (contact fields, honeypot, buttons) is handled
 * explicitly by the submit path. Multi-select inputs post the same name once
 * per chosen value, so those are joined into one answer string. File inputs
 * are handled separately (their value is a File, not a string).
 */
export function collectAnswers(form: FormData): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const key of new Set(form.keys())) {
    if (!key.startsWith(FIELD_PREFIX)) continue;
    const values = form.getAll(key).filter((value): value is string => typeof value === 'string');
    if (!values.length) continue;
    answers[key] = values.join(MULTI_VALUE_SEPARATOR);
  }
  return answers;
}

/** Splits a stored answer back into the individual chosen values. */
export function splitAnswer(value: string): string[] {
  return value.split(MULTI_VALUE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
}

/**
 * Required questions with no answer. A grid question is answered only when
 * EVERY row has a value; everything else needs its own field filled.
 */
export function missingRequiredFields(form: CmsPage, language: string, answers: Record<string, string>): FormFieldVM[] {
  return allFormFields(form, language).filter((field) => {
    if (!field.required) return false;
    if (GRID_TYPES.has(field.type)) {
      return field.rows.some((row) => (answers[row.name] ?? '').trim() === '');
    }
    return (answers[field.name] ?? '').trim() === '';
  });
}

/**
 * Options for choice questions. Accepts the legacy `value:label|value:label`
 * encoding and the form editor's one-option-per-line encoding (each line
 * `value:label`, or a bare value used as both).
 */
export function parseOptions(encoded: string): Array<{ value: string; label: string }> {
  return encoded
    .split(/[\n|]/)
    .map((part) => {
      const [value, label] = part.split(':');
      return { value: (value ?? '').trim(), label: (label ?? value ?? '').trim() };
    })
    .filter((option) => option.value !== '' || option.label !== '');
}

/** Non-empty trimmed lines — grid rows are edited one per line. */
export function parseLines(encoded: string): string[] {
  return encoded.split(/[\n|]/).map((line) => line.trim()).filter(Boolean);
}

/** Unknown/legacy type strings fall back to a short answer. */
function normalizeType(type: string): string {
  const normalized = type.trim().toLowerCase();
  return QUESTION_TYPES.some((option) => option.value === normalized) ? normalized : 'text';
}

function positiveInt(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveOrZeroInt(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[/()]/g, '').replace(/\s+/g, '-');
}

export function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'yes' || normalized === 'true';
}
