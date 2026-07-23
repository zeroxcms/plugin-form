// ============================================================
// Google-Forms-style editor for `form` pages.
//
// Declared in the manifest as `editViews: ["form"]`, so the CMS hands the
// page editor for form pages to this plugin: it POSTs the editor context to
// /__plugin/edit and wraps the returned client view in the admin chrome
// (host `cms/src/plugins/edit-view.ts`). The editor is purely a VIEW — its
// single <form> posts back to the CMS's own save handler (`ctx.action`)
// using the CMS field-name grammar, so save / versioning / auto-publish are
// unchanged:
//
//   name, slug, page_type, weight, return_to     page basics
//   @attr             .field|<lang>              page lect fields
//   #<i>@_type  #<i>@_weight  #<i>@attr  #<i>.field|<lang>   block fields
//   #<i>.custom_input[<j>]@attr / .label|<lang> / @_weight    question rows
//   action=update | block-add (+ block-select) | block-delete:<i>
//        | block-item-add:<i>|custom_input
//        | block-item-delete:<i>|custom_input|<j>              structured ops
//
// Add/delete/reorder are full server round-trips through the CMS save
// handler (no client JS required); the optional editor-scroll.js asset
// restores the scroll position and enables drag-reorder of question rows.
// ============================================================

import { attr, items } from './cms';
import { CHOICE_TYPES, GRID_TYPES, QUESTION_TYPES } from './fields';
import { clientViewResponse } from './templates/views';

/** Editor context the CMS POSTs to /__plugin/edit (host plugins/edit-view.ts). */
export interface EditViewContext {
  mode: 'new' | 'edit';
  action: string;
  backHref: string;
  language: string;
  pageType: string;
  page: {
    id: number | string;
    name: string;
    slug: string;
    pageType: string;
    weight: number;
    lect: string;
  };
  flash?: string;
  errors?: string[];
}

// 'mis' is the host's language-neutral default lect key (matches the EDM editor).
const LANGUAGES = [
  { value: 'mis', label: 'Default' },
  { value: 'en', label: 'EN' },
  { value: 'zh-hant', label: '繁' },
  { value: 'zh-hans', label: '简' },
];
const DEFAULT_LANGUAGE = 'mis';

/** Scale/rating defaults shown when a question carries no bounds yet. */
const SCALE_DEFAULTS = { min: '1', max: '5' };
const RATING_DEFAULT_MAX = '5';

const ADD_BLOCK_OPTIONS = [
  { value: 'form-inputs', label: 'Questions' },
  { value: 'form-contact', label: 'Contact details' },
  { value: 'paragraph', label: 'Title & text' },
  { value: 'picture', label: 'Image' },
];

/** Minimal field VM for the host pagefield snippets we reuse (picture, switch). */
interface PageFieldVM {
  id: string;
  inputName: string;
  label: string;
  value: string;
  placeholder: string;
  required: boolean;
}

export async function handleFormEditView(request: Request): Promise<Response> {
  const ctx = (await request.json().catch(() => null)) as EditViewContext | null;
  if (!ctx || ctx.pageType !== 'form') return new Response('not found', { status: 404 });

  const lect = parseLect(ctx.page.lect);
  const lang = LANGUAGES.some((option) => option.value === ctx.language) ? ctx.language : DEFAULT_LANGUAGE;
  const isEdit = ctx.mode === 'edit';
  const status = attr(lect, 'status').trim().toLowerCase() || 'open';

  const title = isEdit ? `Edit ${ctx.page.name}` : 'New form';
  return clientViewResponse(title, '/sections/form-edit.liquid', {
    title,
    action: ctx.action,
    backHref: ctx.backHref || '/admin/pages',
    isEdit,
    flash: ctx.flash ?? '',
    errors: ctx.errors ?? [],
    name: ctx.page.name,
    slug: ctx.page.slug,
    weight: ctx.page.weight,
    open: status !== 'closed',
    language: lang,
    languageOptions: LANGUAGES.map((option) => ({ ...option, selected: option.value === lang })),
    // Header card fields.
    descriptionName: `.description|${lang}`,
    descriptionValue: locExact(lect, 'description', lang),
    descriptionPlaceholder: lang !== DEFAULT_LANGUAGE ? locExact(lect, 'description', DEFAULT_LANGUAGE) : '',
    // Blocks (display in weight order; field names keep the array index).
    blocks: editBlocks(lect, lang),
    addBlockOptions: ADD_BLOCK_OPTIONS,
    // Settings card.
    statusName: '@status',
    statusValue: status,
    buttonLabelName: `.button_label|${lang}`,
    buttonLabelValue: locExact(lect, 'button_label', lang),
    thankyouHeadingName: `.thankyou_heading|${lang}`,
    thankyouHeadingValue: locExact(lect, 'thankyou_heading', lang),
    thankyouBodyName: `.thankyou_body|${lang}`,
    thankyouBodyValue: locExact(lect, 'thankyou_body', lang),
    featuredImageField: pageField('@featured_image', 'Header image', attr(lect, 'featured_image')),
    // Actions.
    deleteAction: isEdit ? `/admin/pages/${ctx.page.id}/delete` : '',
  });
}

// ── Block view-models ─────────────────────────────────────────────────────────

interface QuestionVM {
  rowIndex: number;
  label: string;
  labelName: string;
  labelValue: string;
  labelPlaceholder: string;
  typeName: string;
  typeOptions: Array<{ value: string; label: string; selected: boolean }>;
  /** Which type-specific config panel the editor shows for this question. */
  isChoice: boolean;
  isGrid: boolean;
  isScale: boolean;
  isRating: boolean;
  isFile: boolean;
  optionsLabel: string;
  optionsName: string;
  optionsValue: string;
  rowsName: string;
  rowsValue: string;
  minName: string;
  minValue: string;
  maxName: string;
  maxValue: string;
  minLabelName: string;
  minLabelValue: string;
  maxLabelName: string;
  maxLabelValue: string;
  acceptName: string;
  acceptValue: string;
  maxSizeName: string;
  maxSizeValue: string;
  fieldNameName: string;
  fieldNameValue: string;
  requiredName: string;
  requiredChecked: boolean;
  weightId: string;
  weightName: string;
  weightValue: number;
  deleteAction: string;
  canDelete: boolean;
}

function editBlocks(lect: Record<string, unknown>, lang: string): Array<Record<string, unknown>> {
  const raw = Array.isArray(lect._blocks) ? (lect._blocks as Array<Record<string, unknown>>) : [];
  const models = raw.map((block, index) => {
    const type = attr(block, '_type') || 'form-inputs';
    const prefix = `#${index}`;
    const base = {
      index,
      type,
      prefix,
      typeFieldName: `${prefix}@_type`,
      weightName: `${prefix}@_weight`,
      weightId: fieldId(`${prefix}@_weight`),
      weightValue: Number(block._weight) || index,
      deleteAction: `block-delete:${index}`,
      titleName: `${prefix}.title|${lang}`,
      titleValue: locExact(block, 'title', lang),
      bodyName: `${prefix}.body|${lang}`,
      bodyValue: locExact(block, 'body', lang),
    };

    switch (type) {
      case 'form-inputs': {
        const rows = items(block, 'custom_input');
        const questions: QuestionVM[] = rows
          .map((row, rowIndex) => ({ row, rowIndex, weight: itemWeight(row, rowIndex) }))
          .sort((a, b) => a.weight - b.weight || a.rowIndex - b.rowIndex)
          .map(({ row, rowIndex, weight }, displayIndex) => {
            const rowPrefix = `${prefix}.custom_input[${rowIndex}]`;
            const rowType = attr(row, 'type') || 'text';
            const isGrid = GRID_TYPES.has(rowType);
            return {
              rowIndex,
              label: `Question ${displayIndex + 1}`,
              labelName: `${rowPrefix}.label|${lang}`,
              labelValue: locExact(row, 'label', lang),
              labelPlaceholder: lang !== DEFAULT_LANGUAGE ? locExact(row, 'label', DEFAULT_LANGUAGE) : 'Untitled question',
              typeName: `${rowPrefix}@type`,
              typeOptions: QUESTION_TYPES.map((option) => ({ ...option, selected: option.value === rowType })),
              isChoice: CHOICE_TYPES.has(rowType),
              isGrid,
              isScale: rowType === 'scale',
              isRating: rowType === 'rating',
              isFile: rowType === 'file',
              // A grid's options are its COLUMNS; flat choice types just list options.
              optionsLabel: isGrid ? 'Columns' : 'Options',
              // Options and row labels are text respondents read, so they are
              // localized value fields (`.field|lang`) like the question label
              // — a translator switching language retranslates them too.
              optionsName: `${rowPrefix}.default_value|${lang}`,
              // Stored `value:label|value:label` (or legacy pipes) shown one
              // option per line; the public renderer accepts both encodings.
              optionsValue: linesOf(locExact(row, 'default_value', lang)),
              rowsName: `${rowPrefix}.rows|${lang}`,
              rowsValue: linesOf(locExact(row, 'rows', lang)),
              minName: `${rowPrefix}@min`,
              minValue: attr(row, 'min') || SCALE_DEFAULTS.min,
              maxName: `${rowPrefix}@max`,
              maxValue: attr(row, 'max') || (rowType === 'rating' ? RATING_DEFAULT_MAX : SCALE_DEFAULTS.max),
              minLabelName: `${rowPrefix}.min_label|${lang}`,
              minLabelValue: locExact(row, 'min_label', lang),
              maxLabelName: `${rowPrefix}.max_label|${lang}`,
              maxLabelValue: locExact(row, 'max_label', lang),
              acceptName: `${rowPrefix}@accept`,
              acceptValue: attr(row, 'accept'),
              maxSizeName: `${rowPrefix}@max_size`,
              maxSizeValue: attr(row, 'max_size'),
              fieldNameName: `${rowPrefix}@name`,
              fieldNameValue: attr(row, 'name'),
              requiredName: `${rowPrefix}@required`,
              requiredChecked: attr(row, 'required').trim().toLowerCase() === 'yes',
              weightId: fieldId(`${rowPrefix}@_weight`),
              weightName: `${rowPrefix}@_weight`,
              weightValue: weight,
              deleteAction: `block-item-delete:${index}|custom_input|${rowIndex}`,
              canDelete: rows.length > 1,
            };
          });
        return {
          ...base,
          questions,
          addQuestionAction: `block-item-add:${index}|custom_input`,
        };
      }
      case 'form-contact':
        return {
          ...base,
          nameLabelName: `${prefix}.label_name|${lang}`,
          nameLabelValue: locExact(block, 'label_name', lang),
          emailLabelName: `${prefix}.label_email|${lang}`,
          emailLabelValue: locExact(block, 'label_email', lang),
          requireEmailName: `${prefix}@require_email`,
          requireEmailChecked: attr(block, 'require_email').trim().toLowerCase() === 'yes',
        };
      case 'picture':
        return {
          ...base,
          pictureField: pageField(`${prefix}@picture`, 'Image', attr(block, 'picture')),
          captionName: `${prefix}.caption|${lang}`,
          captionValue: locExact(block, 'caption', lang),
        };
      case 'paragraph':
      default:
        return {
          ...base,
          subjectName: `${prefix}.subject|${lang}`,
          subjectValue: locExact(block, 'subject', lang),
        };
    }
  });
  // Display in weight order, but the field names keep the original array index.
  return models.sort((a, b) => Number(a.weightValue) - Number(b.weightValue));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pageField(inputName: string, label: string, value: string): PageFieldVM {
  return { id: fieldId(inputName), inputName, label, value, placeholder: '', required: false };
}

function parseLect(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Exact-language value of a localized field (no cross-language fallback —
 *  the editor must show emptiness so translators see what's missing). */
function locExact(lect: Record<string, unknown>, key: string, lang: string): string {
  const value = lect[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    return map[lang] == null ? '' : String(map[lang]);
  }
  return value == null ? '' : String(value);
}

/** Stored pipe/newline lists are edited one entry per line. */
function linesOf(value: string): string {
  return value.split(/[\n|]/).map((part) => part.trim()).filter(Boolean).join('\n');
}

function itemWeight(item: Record<string, unknown>, fallback: number): number {
  const weight = Number(item._weight);
  return Number.isFinite(weight) ? weight : fallback;
}

/** Mirrors the host's field-id derivation so labels stay unique + focusable. */
function fieldId(inputName: string): string {
  return `field_${Array.from(inputName)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`))
    .join('')}`;
}
