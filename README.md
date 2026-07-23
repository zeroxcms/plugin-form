# plugin-form

Form builder for 0xCMS — a Google-Forms-style plugin Worker on the standard
plugin contract, reusing the events-suite / worker-rsvp blueprint.

This Worker is the **admin** side only (`/__plugin/admin/*`, proxied by the
host to `/admin/plugins/form/*`): form index, the Google-Forms-style page
editor, per-form dashboard (share link, open/close, question summary),
submissions table, CSV export, delete.

Visitors are served by **[worker-form](../worker-form)** — a separate Worker on
its own public domain that renders published forms from the CMS's published D1
and records responses into it. Point `PUBLIC_BASE_URL` at it. The two Workers
never call each other; the published database is the only thing between them.

## How a form is built

A form is a CMS page (`page_type: form`). The manifest declares
`editViews: ["form"]`, so the CMS hands the page editor to this plugin, which
renders a Google-Forms-style editor (`src/edit-view.ts` +
`views/sections/form-edit.liquid`): a title card with an accent strip, one
card per question with a type dropdown (Short answer / Paragraph / Multiple
choice / Checkbox / Dropdown / …), options one per line, a Required toggle,
and Add question / Add to form controls. The editor is purely a view — its
form posts back to the CMS's own save handler using the CMS field grammar
(`@attr`, `.field|lang`, `#i.custom_input[j]@key`, `block-add` /
`block-delete:` / `block-item-*` actions), so saving, versioning and
auto-publish stay host-side, and add/remove/reorder work without any client
JS. The approved `editor-scroll.js` asset (Plugins → form → assets) adds
scroll restoration and drag-reorder on top.

Under the hood the page's blocks are the form definition (declared in
`src/manifest.json`):

| block | purpose |
| --- | --- |
| `paragraph` / `picture` | static content between questions |
| `form-contact` | submitter name + email (email optionally required) |
| `form-inputs` | question list — the `custom_input` item shape ported from the events plugin's `rsvp-custom` block |

### Question types

Every Google Forms type is supported:

| Type | `@type` | Config |
| --- | --- | --- |
| Short answer / Paragraph | `text` / `textarea` | — |
| Multiple choice / Checkboxes / Dropdown | `radio` / `checkboxes` / `select` | options, one per line |
| Linear scale | `scale` | `@min`, `@max`, `min_label`, `max_label` |
| Rating | `rating` | `@max` (stars) |
| Multiple choice grid / Checkbox grid | `grid-radio` / `grid-checkbox` | columns (`default_value`) + `rows` |
| File upload | `file` | `@accept`, `@max_size` (MB) |
| Date / Time / Email / Number / URL / Phone | `date` … | — |
| Single checkbox (consent) | `checkbox` | — |

Options are one per line (`value:label`, or a bare value used as both); the
legacy `a|b|c` encoding still parses. Config values are attributes (`@name`);
everything a respondent reads (`label`, `default_value`, `rows`, scale labels)
is a localized value, so it can be translated per language.

Answer keys: `form-<name-slug>` — so answers survive label edits when an
explicit `name` is set. Multi-select answers are joined with `", "`; grid
questions store **one answer per row** under `form-<slug>__<row-slug>` and
expand to one CSV column per row. `src/fields.ts` derives those keys from the
form definition; worker-form derives the same keys when it renders and stores
a response, so the two must agree.

### File uploads

worker-form stores a validated upload in the shared `UPLOADS` R2 bucket under
`form-<id>/<uuid>-<name>`, and the answer holds that key. Bind the same bucket
here (see `wrangler.toml`) and the submissions table turns those answers into
download links. Files are **never public** — the only path to one is
`/admin/plugins/form/forms/<id>/files/<key>`, which verifies the key belongs to
that form. Without the binding, the admin side still works; file answers just
show as text.

"New form" seeds a starter contact block + one sample question, then opens the
page editor. `form` is in `autoPublishTypes`, so saving publishes the page and
the public link works immediately.

## Submission flow

1. A visitor POSTs `/f/<slug>` on **worker-form**, which validates and writes
   `INSERT INTO live_pages` (`form_submission`, negative id, `page_id` = form
   id) in the published D1. Nothing reaches this Worker.
2. worker-cms's generic submission ingest (cron, or the admin's
   "Pull new submissions" button → `POST /__cms/ingest/submissions`) mirrors
   live-only rows into draft pages and fires this plugin's `submission` hook.
3. The admin reads the mirrored pages via the Plugin API
   (`page_type=form_submission&page_id=<form id>`) for the dashboard, table,
   and CSV export. Deleting a form trashes its submissions server-side
   (`DELETE /__cms/pages/children`) before the form itself.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # CMS_URL + PLUGIN_SECRET must match the host's
npm run dev
```

- Register the plugin in the CMS admin under **Plugins** by its HTTPS URL; copy
  the dedicated secret into this Worker (`wrangler secret put PLUGIN_SECRET`).
- Deploy [worker-form](../worker-form) and set `PUBLIC_BASE_URL` to its origin,
  so the dashboard's shareable link is right. Bind the same `UPLOADS` bucket it
  writes to if any form uses file questions.
- Multi-tenant: `npm run kv:setup` creates the `TENANTS` KV namespace; add one
  `tenant:<cms origin>` record per connected CMS (see `wrangler.toml`).

## Development

```sh
npm run typecheck
npm test
```

Tests drive the Worker directly with a mocked `fetch` standing in for
`{CMS_URL}/__cms/*`, mirroring the cms-plugin-events test pattern. Public
rendering and submit behaviour is covered in worker-form's own suite.
