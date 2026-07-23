// ============================================================
// Form field projection — shared by the admin views (field summary, CSV
// headers) and the public renderer.
//
// A form page's fields live in its `_blocks`: `form-inputs` blocks carry a
// `custom_input` item list (the same shape as the events plugin's rsvp-custom
// block), and an optional `form-contact` block collects the submitter's
// name/email. Public form fields are named `form-<name-slug>` (the legacy
// custom-input naming scheme with this plugin's prefix), so answers survive
// label edits when an explicit `name` is set.
// ============================================================

import { attr, blocks, items, localized, type CmsPage } from './cms';

/** Prefix of every custom-input form field, and of every stored answer key. */
export const FIELD_PREFIX = 'form-';

export interface FormFieldVM {
  /** Full public form field name (`form-<slug>`), also the stored answer key. */
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: string;
  value: string;
  checked: boolean;
  options: Array<{ value: string; label: string; selected: boolean }>;
}

export interface FormBlockVM {
  type: string;
  title: string;
  bodyHtml: string;
  [key: string]: unknown;
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
      const type = attr(input, 'type') || 'text';
      const defaultValue = attr(input, 'default_value') || localized(input, 'default_value', language);
      const fieldName = `${FIELD_PREFIX}${slugify(name)}`;
      const value = answers[fieldName] ?? '';
      return {
        name: fieldName,
        label,
        type,
        required: truthy(attr(input, 'required')),
        defaultValue,
        value,
        checked: Object.hasOwn(answers, fieldName),
        options: type === 'select' || type === 'radio'
          ? parseOptions(defaultValue).map((option) => ({ ...option, selected: option.value === value }))
          : [],
      };
    })
    .filter((input) => input.label);
}

/** Flat list of every custom input across all form-inputs blocks (admin summary, CSV columns). */
export function allFormFields(form: CmsPage, language = 'en'): FormFieldVM[] {
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

/**
 * Custom-input answers from a public submit, verbatim. Only `form-*` fields
 * qualify — everything else (contact fields, honeypot, buttons) is handled
 * explicitly by the submit path.
 */
export function collectAnswers(form: FormData): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith(FIELD_PREFIX)) answers[key] = String(value);
  }
  return answers;
}

/**
 * Required custom inputs with no answer. Checkbox answers count when present
 * at all (an unchecked required checkbox is missing).
 */
export function missingRequiredFields(form: CmsPage, language: string, answers: Record<string, string>): FormFieldVM[] {
  return allFormFields(form, language).filter((field) => {
    if (!field.required) return false;
    const value = answers[field.name];
    return value === undefined || value.trim() === '';
  });
}

/** `value:label|value:label` → options (legacy select/radio encoding). */
export function parseOptions(encoded: string): Array<{ value: string; label: string }> {
  return encoded
    .split('|')
    .map((part) => {
      const [value, label] = part.split(':');
      return { value: (value ?? '').trim(), label: (label ?? value ?? '').trim() };
    })
    .filter((option) => option.value !== '' || option.label !== '');
}

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[/()]/g, '').replace(/\s+/g, '-');
}

export function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'yes' || normalized === 'true';
}
