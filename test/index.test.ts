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
