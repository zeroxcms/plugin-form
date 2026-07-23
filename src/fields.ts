// ============================================================
// Form definition reader — the admin's view of a form's questions: the type
// menu the editor offers, the field summary on the dashboard, and the answer
// columns of the submissions table and CSV export.
//
// A form page's fields live in its `_blocks`: `form-inputs` blocks carry a
// `custom_input` item list (the shape ported from the events plugin's
// rsvp-custom block), and an optional `form-contact` block collects the
// submitter's name/email. Public form fields are named `form-<name-slug>`
// (the legacy custom-input naming scheme with this plugin's prefix), so
// answers survive label edits when an explicit `name` is set.
//
// Rendering those questions to visitors — and collecting the answers — is
// worker-form's job (worker-form/src/fields.ts projects the same blocks for
// the public template). The two must agree on the answer KEYS: one per
// question, and for grid questions one per ROW under
// `form-<slug>__<row-slug>`. Everything else here is admin-only.
// ============================================================

import { attr, blocks, items, localized, type CmsPage } from './cms';

/** Prefix of every custom-input form field, and of every stored answer key. */
const FIELD_PREFIX = 'form-';

/** Separator between a grid question's field name and its row slug. */
const ROW_SEPARATOR = '__';

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

/** One row of a grid question — its own field, and its own stored answer. */
export interface FormFieldRow {
  label: string;
  /** `<field><ROW_SEPARATOR><row-slug>`. */
  name: string;
}

export interface FormField {
  /** Full public form field name (`form-<slug>`), also the stored answer key. */
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** Matrix rows (grid types only). */
  rows: FormFieldRow[];
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

/** Flat list of every custom input across all form-inputs blocks. */
export function allFormFields(form: CmsPage, language = 'mis'): FormField[] {
  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const block of blocks(form.lect)) {
    if (attr(block, '_type') !== 'form-inputs') continue;
    for (const field of customInputFields(block, language)) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      fields.push(field);
    }
  }
  return fields;
}

/** Legacy field-name scheme: `form-<name-or-label slug>` (lowercased, spaces → dashes). */
function customInputFields(block: Record<string, unknown>, language: string): FormField[] {
  return items(block, 'custom_input')
    .map((input) => {
      const label = localized(input, 'label', language);
      const name = attr(input, 'name') || slugify(label);
      const type = normalizeType(attr(input, 'type'));
      const fieldName = `${FIELD_PREFIX}${slugify(name)}`;
      return {
        name: fieldName,
        label,
        type,
        required: truthy(attr(input, 'required')),
        rows: GRID_TYPES.has(type) ? gridRows(input, fieldName, language) : [],
      };
    })
    .filter((input) => input.label);
}

/** Matrix rows for a grid question — one form field per row, edited one per line. */
function gridRows(input: Record<string, unknown>, fieldName: string, language: string): FormFieldRow[] {
  const encoded = localized(input, 'rows', language) || attr(input, 'rows');
  return encoded
    .split(/[\n|]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ label, name: `${fieldName}${ROW_SEPARATOR}${slugify(label)}` }));
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

/** Unknown/legacy type strings fall back to a short answer. */
function normalizeType(type: string): string {
  const normalized = type.trim().toLowerCase();
  return QUESTION_TYPES.some((option) => option.value === normalized) ? normalized : 'text';
}

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[/()]/g, '').replace(/\s+/g, '-');
}

function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'yes' || normalized === 'true';
}
