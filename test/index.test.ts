import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTenantCache } from '@lionrockjs/worker-cms-plugin';
import worker from '../src/index';
import { renderView } from '../src/templates/liquid';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  PUBLISHED_DB?: D1Database;
  UPLOADS?: R2Bucket;
  VIEWS: Fetcher;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

const plugin = worker as {
  fetch(request: Request, env: PluginEnv): Promise<Response>;
};

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        // The form editor reuses host pagefield snippets (picture, …); in
        // production the plugin redirects those view paths to the host.
        if (url.pathname.startsWith('/snippets/pagefield/')) {
          try {
            return new Response(await readFile(fileURLToPath(new URL(`../../../../workers/cms/views${url.pathname}`, import.meta.url).href), 'utf8'));
          } catch {
            // Fall through to the normal not-found response.
          }
        }
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

async function renderedText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  const data = await response.clone().json() as Record<string, unknown>;
  return renderView(views(), viewPath, data);
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.test',
    PLUGIN_SECRET: 'shared-secret',
    ...overrides,
  };
}

function adminRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-plugin-secret', 'shared-secret');
  return new Request(`https://form.test${path}`, { ...init, headers });
}

interface RecordedCall {
  method: string;
  url: URL;
  body: unknown;
}

/** Stubs global fetch for the {CMS_URL}/__cms/* Plugin API and records calls. */
function stubCms(handler: (method: string, url: URL, body: unknown) => Response | null): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const response = handler(method, url, body);
    if (response) return response;
    throw new Error(`Unexpected CMS call: ${method} ${url.href}`);
  });
  return calls;
}

// ── Fake published D1 ─────────────────────────────────────────────────────────

interface FakeRow extends Record<string, unknown> {
  id: number;
  page_type: string | null;
  slug: string;
}

function fakePublishedDb(rows: FakeRow[]) {
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (/INSERT INTO live_pages/i.test(sql)) throw new Error('first() on insert');
              if (/WHERE id = \?/.test(sql)) return rows.find((row) => row.id === args[0]) ?? null;
              if (/WHERE page_type = \? AND slug = \?/.test(sql)) {
                return rows.find((row) => row.page_type === args[0] && row.slug === args[1]) ?? null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (/INSERT INTO live_pages/i.test(sql)) inserts.push(args);
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, inserts };
}

function publishedForm(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 301,
    uuid: 'form-uuid',
    created_at: '2026-07-01 00:00:00',
    updated_at: '2026-07-01 00:00:00',
    name: 'Feedback',
    slug: 'feedback-abc123',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_type: 'form',
    page_id: null,
    lect: JSON.stringify({
      _type: 'form',
      name: { en: 'Feedback' },
      status: 'open',
      button_label: 'Send',
      thankyou_heading: 'Thanks!',
      thankyou_body: { en: '<p>Recorded.</p>' },
      _blocks: [
        {
          _id: 'contact',
          _type: 'form-contact',
          _weight: 1,
          title: { en: 'Your details' },
          label_name: { en: 'Full name' },
          label_email: { en: 'Email address' },
          require_email: 'yes',
        },
        {
          _id: 'questions',
          _type: 'form-inputs',
          _weight: 2,
          title: { en: 'Questions' },
          custom_input: [
            { name: 'rating', type: 'radio', required: 'yes', label: { en: 'Rating' }, default_value: '1:Bad|5:Great' },
            { name: 'comments', type: 'textarea', required: 'no', label: { en: 'Comments' }, default_value: '' },
          ],
        },
      ],
    }),
    ...overrides,
  };
}

function cmsFormPage(overrides: Record<string, unknown> = {}) {
  return {
    id: 301,
    uuid: 'form-uuid',
    page_type: 'form',
    name: 'Feedback',
    slug: 'feedback-abc123',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T10:30:00Z',
    lect: JSON.parse(String(publishedForm().lect)),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
});

// ── Plugin contract ───────────────────────────────────────────────────────────

describe('plugin contract', () => {
  it('serves the manifest', async () => {
    const response = await plugin.fetch(new Request('https://form.test/__plugin/manifest'), env());
    expect(response.status).toBe(200);
    const manifest = await response.json() as { id: string; contentTypes: { blueprint: Record<string, unknown> } };
    expect(manifest.id).toBe('form');
    expect(Object.keys(manifest.contentTypes.blueprint)).toEqual(['form', 'form_submission']);
  });

  it('rejects admin calls without the shared secret', async () => {
    const response = await plugin.fetch(new Request('https://form.test/__plugin/admin/forms'), env());
    expect(response.status).toBe(403);
  });

  it('acknowledges submission hooks', async () => {
    const response = await plugin.fetch(adminRequest('/__plugin/hooks/submission', {
      method: 'POST',
      body: JSON.stringify({ page: { id: 1, page_type: 'form_submission' } }),
    }), env());
    expect(response.status).toBe(200);
  });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

describe('forms admin', () => {
  it('lists forms', async () => {
    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'form') {
        return Response.json({ pages: [cmsFormPage()], total: 1 });
      }
      return null;
    });

    const response = await plugin.fetch(adminRequest('/__plugin/admin/forms'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('Feedback');
    expect(html).toContain('/admin/plugins/form/forms/301');
    expect(html).toContain('Open');
  });

  it('creates a form with starter blocks and opens the editor', async () => {
    const calls = stubCms((method, url) => {
      if (method === 'POST' && url.pathname === '/__cms/pages') {
        return Response.json({ page: cmsFormPage({ id: 512 }) });
      }
      return null;
    });

    const body = new URLSearchParams({ name: 'Customer survey' });
    const response = await plugin.fetch(adminRequest('/__plugin/admin/forms/new', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/pages/512/edit');

    const create = calls.find((call) => call.method === 'POST')?.body as {
      page_type: string;
      slug: string;
      lect: { _blocks: Array<{ _type: string }> };
    };
    expect(create.page_type).toBe('form');
    expect(create.slug).toMatch(/^customer-survey-[0-9a-f]{6}$/);
    expect(create.lect._blocks.map((block) => block._type)).toEqual(['form-contact', 'form-inputs']);
  });

  it('renders the dashboard with the public link and field summary', async () => {
    stubCms((method, url) => {
      if (method === 'POST' && url.pathname === '/__cms/ingest/submissions') {
        return Response.json({ scanned: 0, created: 0, more: false });
      }
      if (method === 'GET' && url.pathname === '/__cms/pages/301') {
        return Response.json({ page: cmsFormPage() });
      }
      if (method === 'GET' && url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'form_submission') {
        return Response.json({
          pages: [{
            id: 900,
            page_type: 'form_submission',
            name: 'Ada',
            page_id: 301,
            updated_at: '2026-07-03T00:00:00Z',
            lect: {
              _type: 'form_submission',
              form_id: '301',
              name: 'Ada',
              email: 'ada@example.com',
              submitted_at: '2026-07-03T09:00:00Z',
              answers: { 'form-rating': '5', 'form-comments': 'Nice' },
            },
          }],
          total: 1,
        });
      }
      return null;
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/forms/301'),
      env({ PUBLIC_BASE_URL: 'https://forms.example.com' }),
    );
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('https://forms.example.com/f/feedback-abc123');
    expect(html).toContain('form-rating');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Pull new submissions');
  });

  it('exports submissions as CSV with answer columns', async () => {
    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301') {
        return Response.json({ page: cmsFormPage() });
      }
      if (method === 'GET' && url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'form_submission') {
        return Response.json({
          pages: [{
            id: 900,
            page_type: 'form_submission',
            name: 'Ada',
            page_id: 301,
            lect: {
              name: 'Ada',
              email: 'ada@example.com',
              submitted_at: '2026-07-03T09:00:00Z',
              language: 'en',
              answers: { 'form-rating': '5', 'form-legacy-question': 'kept' },
            },
          }],
          total: 1,
        });
      }
      return null;
    });

    const response = await plugin.fetch(adminRequest('/__plugin/admin/forms/301/export'), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('Rating');
    // Answers whose field was removed from the form keep a fallback column.
    expect(csv).toContain('legacy question');
    expect(csv).toContain('ada@example.com');
    expect(csv).toContain('kept');
  });

  it('deletes a form and its submissions server-side', async () => {
    const calls = stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301') {
        return Response.json({ page: cmsFormPage() });
      }
      if (method === 'DELETE' && url.pathname === '/__cms/pages/children') {
        return Response.json({ trashed: 3, done: true });
      }
      if (method === 'DELETE' && url.pathname === '/__cms/pages/301') {
        return Response.json({ ok: true });
      }
      return null;
    });

    const response = await plugin.fetch(adminRequest('/__plugin/admin/forms/301/delete', { method: 'POST' }), env());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/form/forms');

    const childrenDelete = calls.find((call) => call.url.pathname === '/__cms/pages/children');
    expect(childrenDelete?.body).toMatchObject({ page_id: 301, page_type: 'form_submission' });
  });

  it('renders an error panel instead of a 500 when the CMS errors', async () => {
    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/999') {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return null;
    });

    const response = await plugin.fetch(adminRequest('/__plugin/admin/forms/999'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('CMS responded');
    expect(html).toContain('404');
  });
});

// ── Google-Forms-style edit view ──────────────────────────────────────────────

describe('form edit view', () => {
  function editContext(overrides: Record<string, unknown> = {}) {
    return {
      mode: 'edit',
      action: '/admin/pages/301/edit',
      backHref: '/admin/plugins/form/forms/301',
      language: 'en',
      pageType: 'form',
      page: {
        id: 301,
        name: 'Feedback',
        slug: 'feedback-abc123',
        pageType: 'form',
        weight: 0,
        start: null,
        end: null,
        timezone: null,
        editors: null,
        lect: String(publishedForm().lect),
      },
      versions: [],
      ...overrides,
    };
  }

  function editRequest(context: Record<string, unknown>): Request {
    return adminRequest('/__plugin/edit', {
      method: 'POST',
      body: JSON.stringify(context),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('renders question cards posting the CMS block field grammar', async () => {
    const response = await plugin.fetch(editRequest(editContext()), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-client-view')).toBe('1');
    const html = await renderedText(response);

    // Page basics post back to the CMS save handler.
    expect(html).toContain('action="/admin/pages/301/edit"');
    expect(html).toContain('name="name" value="Feedback"');
    expect(html).toContain('name="slug" value="feedback-abc123"');
    expect(html).toContain('name="@status"');

    // The contact block (index 0) and questions block (index 1) keep their
    // array indices in the field names.
    expect(html).toContain('name="#0@_type" value="form-contact"');
    expect(html).toContain('name="#0.label_name|en"');
    expect(html).toContain('name="#1@_type" value="form-inputs"');
    expect(html).toContain('name="#1.custom_input[0].label|en" value="Rating"');
    expect(html).toContain('name="#1.custom_input[0]@type"');
    // Radio question: options textarea shows one option per line.
    expect(html).toContain('name="#1.custom_input[0].default_value|en"');
    expect(html).toContain('1:Bad\n5:Great');
    // Structured block operations (server round-trips, no JS required).
    expect(html).toContain('value="block-item-add:1|custom_input"');
    expect(html).toContain('value="block-item-delete:1|custom_input|0"');
    expect(html).toContain('value="block-add"');
    expect(html).toContain('value="block-delete:0"');
    // Approved-asset enhancement (scroll restore + drag reorder).
    expect(html).toContain('/admin/plugins/form/assets/editor-scroll.js');
  });

  it('declines other page types so the CMS falls back to its editor', async () => {
    const response = await plugin.fetch(editRequest(editContext({ pageType: 'event' })), env());
    expect(response.status).toBe(404);
  });

  it('serves the editor-scroll asset on the bare and admin paths', async () => {
    const bare = await plugin.fetch(new Request('https://form.test/assets/editor-scroll.js'), env());
    expect(bare.status).toBe(200);
    expect(bare.headers.get('content-type')).toContain('text/javascript');
    const proxied = await plugin.fetch(adminRequest('/__plugin/admin/assets/editor-scroll.js'), env());
    expect(proxied.status).toBe(200);
  });
});

// ── Google Forms question types ───────────────────────────────────────────────

/** A form exercising every question type that renders its own control. */
function richForm(): FakeRow {
  const lect = JSON.parse(String(publishedForm().lect)) as Record<string, unknown>;
  lect._blocks = [
    {
      _id: 'questions',
      _type: 'form-inputs',
      _weight: 1,
      title: { mis: 'Questions' },
      custom_input: [
        { name: 'topics', type: 'checkboxes', required: 'no', label: { mis: 'Topics' }, default_value: 'a:Alpha\nb:Beta\nc:Gamma' },
        { name: 'nps', type: 'scale', required: 'no', label: { mis: 'Recommend us' }, min: '1', max: '5', min_label: { mis: 'Never' }, max_label: { mis: 'Always' } },
        { name: 'stars', type: 'rating', required: 'no', label: { mis: 'Overall' }, max: '5' },
        { name: 'venue', type: 'grid-radio', required: 'no', label: { mis: 'Rate the venue' }, default_value: 'good:Good\nbad:Bad', rows: { mis: 'Food\nSeating' } },
        { name: 'days', type: 'grid-checkbox', required: 'no', label: { mis: 'Availability' }, default_value: 'am:AM\npm:PM', rows: { mis: 'Monday\nTuesday' } },
        { name: 'cv', type: 'file', required: 'no', label: { mis: 'Attach your CV' }, accept: 'pdf', max_size: '5' },
      ],
    },
  ];
  return publishedForm({ lect: JSON.stringify(lect) });
}

describe('question types', () => {
  it('renders every Google-Forms control on the public form', async () => {
    const { db } = fakePublishedDb([richForm()]);
    const response = await plugin.fetch(
      new Request('https://form.test/f/feedback-abc123'),
      env({ PUBLISHED_DB: db, UPLOADS: fakeBucket().bucket }),
    );
    const html = await response.text();

    // Checkboxes: one input per option, all sharing the field name.
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="form-topics"');
    expect(html).toContain('Gamma');
    // Linear scale: numbered radios between the two end labels.
    expect(html).toContain('Never');
    expect(html).toContain('Always');
    expect(html).toContain('id="form-nps-5"');
    // Rating: stars emitted in DESCENDING order for the CSS-only fill rule.
    expect(html.indexOf('id="form-stars-5"')).toBeLessThan(html.indexOf('id="form-stars-1"'));
    // Grids: one field per ROW, columns as headers.
    expect(html).toContain('name="form-venue__food"');
    expect(html).toContain('name="form-venue__seating"');
    expect(html).toContain('name="form-days__monday"');
    // File upload forces multipart and advertises its constraints.
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".pdf"');
    expect(html).toContain('Max 5 MB');
  });

  it('disables file questions when no bucket is bound, keeping the rest usable', async () => {
    const { db } = fakePublishedDb([richForm()]);
    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123'), env({ PUBLISHED_DB: db }));
    const html = await response.text();
    expect(html).toContain('File uploads are not available');
    expect(html).toContain('disabled');
    // A form with no usable file input must not ask for a multipart body.
    expect(html).not.toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="form-topics"');
  });

  it('stores multi-select and per-row grid answers', async () => {
    const { db, inserts } = fakePublishedDb([richForm()]);
    const body = new URLSearchParams();
    body.append('form-topics', 'a');
    body.append('form-topics', 'c');
    body.append('form-nps', '4');
    body.append('form-stars', '5');
    body.append('form-venue__food', 'good');
    body.append('form-venue__seating', 'bad');
    body.append('form-days__monday', 'am');
    body.append('form-days__monday', 'pm');

    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env({ PUBLISHED_DB: db }));

    expect(response.status).toBe(303);
    const lect = JSON.parse((inserts[0] as string[])[4]) as { answers: Record<string, string> };
    // Several values for one field collapse into one comma-joined answer.
    expect(lect.answers['form-topics']).toBe('a, c');
    expect(lect.answers['form-days__monday']).toBe('am, pm');
    expect(lect.answers['form-nps']).toBe('4');
    expect(lect.answers['form-stars']).toBe('5');
    expect(lect.answers['form-venue__food']).toBe('good');
    expect(lect.answers['form-venue__seating']).toBe('bad');
  });

  it('requires every row of a required grid question', async () => {
    const lect = JSON.parse(String(richForm().lect)) as Record<string, unknown>;
    const blocks = lect._blocks as Array<{ custom_input: Array<Record<string, unknown>> }>;
    blocks[0].custom_input = [blocks[0].custom_input[3]]; // the grid-radio, made required
    blocks[0].custom_input[0].required = 'yes';
    const { db, inserts } = fakePublishedDb([publishedForm({ lect: JSON.stringify(lect) })]);

    const body = new URLSearchParams({ 'form-venue__food': 'good' }); // Seating left blank
    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env({ PUBLISHED_DB: db }));

    expect(response.status).toBe(400);
    expect(inserts.length).toBe(0);
    expect(await response.text()).toContain('Rate the venue');
  });

  it('offers every new type in the editor and shows its config panel', async () => {
    const lect = JSON.parse(String(richForm().lect));
    const response = await plugin.fetch(adminRequest('/__plugin/edit', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'edit',
        action: '/admin/pages/301/edit',
        backHref: '/admin/plugins/form/forms/301',
        language: 'mis',
        pageType: 'form',
        page: { id: 301, name: 'Feedback', slug: 'feedback-abc123', pageType: 'form', weight: 0, lect: JSON.stringify(lect) },
        versions: [],
      }),
      headers: { 'content-type': 'application/json' },
    }), env());
    const html = await renderedText(response);

    for (const label of ['Checkboxes', 'File upload', 'Linear scale', 'Rating', 'Multiple choice grid', 'Checkbox grid']) {
      expect(html).toContain(label);
    }
    // Grid question: options panel is relabelled "Columns" and gains Rows.
    expect(html).toContain('Columns');
    expect(html).toContain('name="#0.custom_input[3].rows|mis"');
    expect(html).toContain('Food\nSeating');
    // Scale bounds and labels, rating stars, file constraints.
    expect(html).toContain('name="#0.custom_input[1]@min"');
    expect(html).toContain('name="#0.custom_input[1].max_label|mis"');
    expect(html).toContain('name="#0.custom_input[2]@max"');
    expect(html).toContain('name="#0.custom_input[5]@accept"');
    expect(html).toContain('name="#0.custom_input[5]@max_size"');
    // Config a question's type doesn't currently show still round-trips.
    expect(html).toContain('type="hidden" name="#0.custom_input[0].rows|mis"');
  });
});

// ── File uploads ──────────────────────────────────────────────────────────────

/** Minimal in-memory R2 stand-in covering put/get + writeHttpMetadata. */
function fakeBucket() {
  const objects = new Map<string, { body: string; contentType: string }>();
  const bucket = {
    async put(key: string, value: ReadableStream, options?: { httpMetadata?: { contentType?: string } }) {
      const body = await new Response(value).text();
      objects.set(key, { body, contentType: options?.httpMetadata?.contentType ?? '' });
    },
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        body: new Response(stored.body).body,
        writeHttpMetadata(headers: Headers) { headers.set('content-type', stored.contentType); },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

function pdfFile(name = 'cv.pdf', body = '%PDF-1.4 hello'): File {
  return new File([body], name, { type: 'application/pdf' });
}

describe('file upload questions', () => {
  function fileForm(): FakeRow {
    const lect = JSON.parse(String(publishedForm().lect)) as Record<string, unknown>;
    lect._blocks = [{
      _id: 'questions',
      _type: 'form-inputs',
      _weight: 1,
      custom_input: [{ name: 'cv', type: 'file', required: 'no', label: { mis: 'CV' }, accept: 'pdf', max_size: '5' }],
    }];
    return publishedForm({ lect: JSON.stringify(lect) });
  }

  async function submitFile(file: File, uploads: R2Bucket | undefined, db: D1Database): Promise<Response> {
    const body = new FormData();
    body.append('form-cv', file);
    return plugin.fetch(
      new Request('https://form.test/f/feedback-abc123', { method: 'POST', body }),
      env({ PUBLISHED_DB: db, UPLOADS: uploads }),
    );
  }

  it('stores a valid file under the form prefix and records its key', async () => {
    const { db, inserts } = fakePublishedDb([fileForm()]);
    const { bucket, objects } = fakeBucket();
    const response = await submitFile(pdfFile(), bucket, db);

    expect(response.status).toBe(303);
    const key = [...objects.keys()][0];
    expect(key).toMatch(/^form-301\/[0-9a-f-]{36}-cv\.pdf$/);
    const lect = JSON.parse((inserts[0] as string[])[4]) as { answers: Record<string, string> };
    expect(lect.answers['form-cv']).toBe(key);
  });

  it('rejects a file whose bytes do not match its extension', async () => {
    const { db, inserts } = fakePublishedDb([fileForm()]);
    const { bucket, objects } = fakeBucket();
    const response = await submitFile(pdfFile('cv.pdf', 'not really a pdf'), bucket, db);

    expect(response.status).toBe(400);
    expect(objects.size).toBe(0);
    expect(inserts.length).toBe(0);
    expect(await response.text()).toContain('not a valid file of that type');
  });

  it('rejects a disallowed extension', async () => {
    const { db } = fakePublishedDb([fileForm()]);
    const { bucket, objects } = fakeBucket();
    const response = await submitFile(new File(['<script>'], 'evil.html', { type: 'text/html' }), bucket, db);

    expect(response.status).toBe(400);
    expect(objects.size).toBe(0);
    expect(await response.text()).toContain('unsupported file type');
  });

  it('serves a stored file to the admin and refuses another form\'s key', async () => {
    const { bucket, objects } = fakeBucket();
    const { db } = fakePublishedDb([fileForm()]);
    await submitFile(pdfFile(), bucket, db);
    const key = [...objects.keys()][0];

    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301') return Response.json({ page: cmsFormPage() });
      return null;
    });

    const download = await plugin.fetch(
      adminRequest(`/__plugin/admin/forms/301/files/${key}`),
      env({ UPLOADS: bucket }),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('cv.pdf');
    // Attacker-supplied bytes must never be sniffed into an executable type.
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await download.text()).toContain('%PDF');

    // A key belonging to a different form must never resolve, even though the
    // admin is authorized for THIS form.
    const wrong = await plugin.fetch(
      adminRequest('/__plugin/admin/forms/301/files/form-999/abc-cv.pdf'),
      env({ UPLOADS: bucket }),
    );
    expect(wrong.status).toBe(404);
  });

  it('lists a file answer as a download link and exports its filename', async () => {
    const key = 'form-301/11111111-2222-3333-4444-555555555555-cv.pdf';
    const lect = JSON.parse(String(fileForm().lect));
    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301') {
        return Response.json({ page: cmsFormPage({ lect }) });
      }
      if (method === 'GET' && url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'form_submission') {
        return Response.json({
          pages: [{
            id: 900, page_type: 'form_submission', name: 'Ada', page_id: 301,
            lect: { name: 'Ada', email: 'ada@example.com', submitted_at: '2026-07-03T09:00:00Z', answers: { 'form-cv': key } },
          }],
          total: 1,
        });
      }
      return null;
    });

    const table = await plugin.fetch(adminRequest('/__plugin/admin/forms/301/submissions'), env());
    const html = await renderedText(table);
    expect(html).toContain('/admin/plugins/form/forms/301/files/form-301/');
    expect(html).toContain('cv.pdf');

    const csv = await (await plugin.fetch(adminRequest('/__plugin/admin/forms/301/export'), env())).text();
    // The CSV carries the human filename, never the internal storage key.
    expect(csv).toContain('cv.pdf');
    expect(csv).not.toContain('11111111-2222');
  });
});

// ── Public form ───────────────────────────────────────────────────────────────

describe('public form', () => {
  it('renders a published form with contact and custom inputs', async () => {
    const { db } = fakePublishedDb([publishedForm()]);
    const response = await plugin.fetch(
      new Request('https://form.test/f/feedback-abc123'),
      env({ PUBLISHED_DB: db }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Full name');
    expect(html).toContain('name="contact-email"');
    expect(html).toContain('name="form-rating"');
    expect(html).toContain('Great');
    expect(html).toContain('name="form-comments"');
    expect(html).toContain('Send');
    // Honeypot present.
    expect(html).toContain('name="website"');
  });

  it('404s for unpublished/unknown forms and non-form pages', async () => {
    const { db } = fakePublishedDb([publishedForm({ page_type: 'event' })]);
    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123'), env({ PUBLISHED_DB: db }));
    expect(response.status).toBe(404);
  });

  it('stores a valid submit as a negative-id live row and redirects to thank-you', async () => {
    const { db, inserts } = fakePublishedDb([publishedForm()]);
    const body = new URLSearchParams({
      'contact-name': 'Ada Lovelace',
      'contact-email': 'ada@example.com',
      'form-rating': '5',
      'form-comments': 'Great event',
    });
    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env({ PUBLISHED_DB: db }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('thank-you');
    expect(inserts.length).toBe(1);
    const [id, name, , pageType, lect, parentId] = inserts[0] as [number, string, string, string, string, number];
    expect(id).toBeLessThan(0);
    expect(name).toBe('Ada Lovelace');
    expect(pageType).toBe('form_submission');
    expect(parentId).toBe(301);
    const parsed = JSON.parse(lect) as { form_id: string; email: string; answers: Record<string, string> };
    expect(parsed.form_id).toBe('301');
    expect(parsed.email).toBe('ada@example.com');
    expect(parsed.answers['form-rating']).toBe('5');
    expect(parsed.answers['form-comments']).toBe('Great event');
  });

  it('re-renders with errors when required fields are missing', async () => {
    const { db, inserts } = fakePublishedDb([publishedForm()]);
    const body = new URLSearchParams({ 'contact-name': '', 'form-comments': 'no rating' });
    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env({ PUBLISHED_DB: db }));

    expect(response.status).toBe(400);
    expect(inserts.length).toBe(0);
    const html = await response.text();
    expect(html).toContain('Name is required.');
    expect(html).toContain('Rating');
    // Previously entered answers survive the round trip.
    expect(html).toContain('no rating');
  });

  it('pretends success for honeypot submissions without storing anything', async () => {
    const { db, inserts } = fakePublishedDb([publishedForm()]);
    const body = new URLSearchParams({ website: 'spam.example', 'contact-name': 'Bot' });
    const response = await plugin.fetch(new Request('https://form.test/f/feedback-abc123', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env({ PUBLISHED_DB: db }));
    expect(response.status).toBe(303);
    expect(inserts.length).toBe(0);
  });

  it('refuses submits to a closed form', async () => {
    const closedLect = JSON.parse(String(publishedForm().lect)) as Record<string, unknown>;
    closedLect.status = 'closed';
    const { db, inserts } = fakePublishedDb([publishedForm({ lect: JSON.stringify(closedLect) })]);

    const view = await plugin.fetch(new Request('https://form.test/f/feedback-abc123'), env({ PUBLISHED_DB: db }));
    expect(await view.text()).toContain('no longer accepting responses');

    const body = new URLSearchParams({ 'contact-name': 'Ada', 'contact-email': 'ada@example.com', 'form-rating': '5' });
    await plugin.fetch(new Request('https://form.test/f/feedback-abc123', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env({ PUBLISHED_DB: db }));
    expect(inserts.length).toBe(0);
  });

  it('shows the thank-you screen from the form settings', async () => {
    const { db } = fakePublishedDb([publishedForm()]);
    const response = await plugin.fetch(
      new Request('https://form.test/f/feedback-abc123?thank-you=1'),
      env({ PUBLISHED_DB: db }),
    );
    const html = await response.text();
    expect(html).toContain('Thanks!');
    expect(html).toContain('<p>Recorded.</p>');
  });
});
