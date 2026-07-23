# plugin-form

Form builder for 0xCMS — a Google-Forms-style plugin Worker on the standard
plugin contract, reusing the events-suite / worker-rsvp blueprint.

One Worker covers both sides:

- **Admin** (`/__plugin/admin/*`, proxied by the host to
  `/admin/plugins/form/*`): form index, per-form dashboard (share link,
  open/close, question summary), submissions table, CSV export, delete.
- **Public** (`/f/<slug>` on this Worker's own domain): renders the published
  form from the CMS's published D1 and stores submits as INSERT-only
  `form_submission` rows — the worker-rsvp "Option B" contract (negative ids,
  live-only uuids), so a CMS republish can never overwrite a response and the
  public path never calls the Plugin API.

## How a form is built

A form is a CMS page (`page_type: form`) edited in the native CMS page editor.
Its blocks are the builder (declared in `src/manifest.json`):

| block | purpose |
| --- | --- |
| `paragraph` / `picture` | static content between questions |
| `form-contact` | submitter name + email (email optionally required) |
| `form-inputs` | question list — the `custom_input` item shape ported from the events plugin's `rsvp-custom` block: `@name`, `@required:boolean`, `@type` (text / email / number / date / textarea / checkbox / select / radio), `label`, `default_value` |

Select/radio options use the legacy encoding in `default_value`:
`value:label|value:label`. Public field names are `form-<name-slug>`, so
answers survive label edits when an explicit `name` is set.

"New form" seeds a starter contact block + one sample question, then opens the
page editor. `form` is in `autoPublishTypes`, so saving publishes the page and
the public link works immediately.

## Submission flow

1. Public POST `/f/<slug>` → honeypot + required-field checks →
   `INSERT INTO live_pages` (`form_submission`, negative id, `page_id` = form id).
2. worker-cms's generic submission ingest (cron, or the admin's
   "Pull new submissions" button → `POST /__cms/ingest/submissions`) mirrors
   live-only rows into draft pages and fires the `submission` hook.
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
- For the public form site, bind the CMS's published D1 as `PUBLISHED_DB` and
  set `PUBLIC_BASE_URL` (see `wrangler.toml`) — the admin dashboard uses it for
  the shareable link. Without the binding the admin still works; `/f/*` 500s.
- Multi-tenant: `npm run kv:setup` creates the `TENANTS` KV namespace; add one
  `tenant:<cms origin>` record per connected CMS (see `wrangler.toml`).

## Development

```sh
npm run typecheck
npm test
```

Tests drive the Worker directly with a mocked `fetch` standing in for
`{CMS_URL}/__cms/*` and a fake `PUBLISHED_DB`, mirroring the
cms-plugin-events test pattern.
