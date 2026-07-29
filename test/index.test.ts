import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTenantCache } from '@lionrockjs/worker-cms-plugin';
import worker from '../src/index';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  TENANTS?: KVNamespace;
  TENANT_ENROLL_ORIGINS?: string;
  PUBLIC_BASE_URL?: string;
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

async function clientViewData(response: Response): Promise<{
  viewPath: string;
  data: Record<string, unknown>;
}> {
  expect(response.headers.get('x-cms-client-view')).toBe('1');
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  return {
    viewPath,
    data: await response.json() as Record<string, unknown>,
  };
}

async function viewSource(viewPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../views${viewPath}`, import.meta.url).href), 'utf8');
}

/**
 * Unit-test the same boundary worker-cms consumes: response data plus the
 * plugin-owned template sources it resolves and renders in the host pipeline.
 */
async function clientViewContractText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const { viewPath, data } = await clientViewData(response);
  const template = await viewSource(viewPath);
  const sources = [JSON.stringify(data), template];
  if (viewPath.endsWith('.json')) {
    const definition = JSON.parse(template) as {
      sections?: Record<string, { type?: string }>;
      order?: string[];
    };
    for (const key of definition.order ?? []) {
      const type = definition.sections?.[key]?.type;
      if (type) sources.push(await viewSource(`/sections/${type}.liquid`));
    }
  }
  return sources.join('\n');
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.test',
    PLUGIN_SECRET: 'shared-secret',
    ...overrides,
  };
}

function fakeTenantKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** The `lect` of a form page as the CMS stores it: settings plus block list. */
function formLect(): Record<string, unknown> {
  return {
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
    lect: formLect(),
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
    const manifest = await response.json() as {
      id: string;
      autoTenant: boolean;
      credits?: unknown;
      contentTypes: { blueprint: Record<string, unknown> };
    };
    expect(manifest.id).toBe('form');
    expect(manifest.autoTenant).toBe(true);
    expect(manifest.credits).toBeUndefined();
    expect(Object.keys(manifest.contentTypes.blueprint)).toEqual(['form', 'form_submission']);
  });

  it('automatically enrolls and revokes a CMS tenant', async () => {
    const cmsOrigin = 'https://cms.example.com';
    const ticket = 't'.repeat(64);
    const secret = 's'.repeat(64);
    const tenants = fakeTenantKv();
    const tenantEnv = env({ CMS_URL: undefined, PLUGIN_SECRET: undefined, TENANTS: tenants });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${cmsOrigin}/__cms/tenant/claim`);
      return Response.json({
        tenant: cmsOrigin,
        cms_url: cmsOrigin,
        plugin_id: 'form',
        secret,
      });
    }));

    const enrolled = await plugin.fetch(new Request('https://form.test/__plugin/tenants/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: cmsOrigin, plugin_id: 'form', ticket }),
    }), tenantEnv);
    expect(enrolled.status).toBe(200);
    expect(tenants.store.has(`tenant:${cmsOrigin}`)).toBe(true);

    const revoked = await plugin.fetch(new Request('https://form.test/__plugin/tenants/revoke', {
      method: 'POST',
      headers: {
        'x-cms-tenant': cmsOrigin,
        'x-plugin-secret': secret,
      },
    }), tenantEnv);
    expect(revoked.status).toBe(200);
    expect(tenants.store.has(`tenant:${cmsOrigin}`)).toBe(false);
  });

  it('rejects admin calls without the shared secret', async () => {
    const response = await plugin.fetch(new Request('https://form.test/__plugin/admin/forms'), env());
    expect(response.status).toBe(403);
  });

  it('serves templates for the worker-cms rendering pipeline', async () => {
    const template = await plugin.fetch(
      new Request('https://form.test/__plugin/views/templates/forms.json'),
      env(),
    );
    expect(template.status).toBe(200);
    expect(await template.json()).toMatchObject({
      sections: { main: { type: 'forms' } },
      order: ['main'],
    });

    const section = await plugin.fetch(
      new Request('https://form.test/__plugin/views/sections/forms.liquid'),
      env(),
    );
    expect(section.status).toBe(200);
    expect(await section.text()).toContain('{% for form in forms %}');
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
    const html = await clientViewContractText(response);
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
    const html = await clientViewContractText(response);
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
    const html = await clientViewContractText(response);
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
        lect: JSON.stringify(formLect()),
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

  /** Stubs the editor's live-status probe (GET /pages/:id?include_live_status=1). */
  function stubLiveStatus(isPublished: boolean) {
    return stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301' && url.searchParams.get('include_live_status') === '1') {
        return Response.json({ page: { ...cmsFormPage(), isPublished } });
      }
      return null;
    });
  }

  it('renders question cards posting the CMS block field grammar', async () => {
    stubLiveStatus(false);
    const response = await plugin.fetch(editRequest(editContext()), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-client-view')).toBe('1');
    const html = await clientViewContractText(response);

    // Page basics post back to the CMS save handler.
    expect(html).toContain('"action":"/admin/pages/301/edit"');
    expect(html).toContain('"name":"Feedback"');
    expect(html).toContain('"slug":"feedback-abc123"');
    expect(html).toContain('"statusName":"@status"');

    // The contact block (index 0) and questions block (index 1) keep their
    // array indices in the field names.
    expect(html).toContain('"typeFieldName":"#0@_type"');
    expect(html).toContain('"nameLabelName":"#0.label_name|en"');
    expect(html).toContain('"typeFieldName":"#1@_type"');
    expect(html).toContain('"labelName":"#1.custom_input[0].label|en"');
    expect(html).toContain('"labelValue":"Rating"');
    expect(html).toContain('"typeName":"#1.custom_input[0]@type"');
    // Radio question: options textarea shows one option per line.
    expect(html).toContain('"optionsName":"#1.custom_input[0].default_value|en"');
    expect(html).toContain('1:Bad\\n5:Great');
    // Publishing is what makes the form visible to worker-form; a plain save
    // only republishes a form that is already live.
    expect(html).toContain('name="action" value="publish"');
    // Structured block operations (server round-trips, no JS required).
    expect(html).toContain('block-item-add:1|custom_input');
    expect(html).toContain('block-item-delete:1|custom_input|0');
    expect(html).toContain('value="block-add"');
    expect(html).toContain('block-delete:0');
    // Approved-asset enhancement (scroll restore + drag reorder).
    expect(html).toContain('/admin/plugins/form/assets/editor-scroll.js');
  });

  it('renders the co-authoring presence bar when the host injects cmsEditPresence', async () => {
    stubLiveStatus(false);
    const response = await plugin.fetch(editRequest(editContext()), env());
    const { viewPath, data } = await clientViewData(response);

    // Presence is host-owned context, not data the plugin should forge.
    expect(data.cmsEditPresence).toBeUndefined();
    expect(viewPath).toBe('/sections/form-edit.liquid');

    // The host resolves page id / user / avatar into cmsEditPresence for
    // edit-mode client views. Verify the Liquid contract worker-cms renders.
    const template = await viewSource(viewPath);
    expect(template).toContain('{% if cmsEditPresence.pageId != blank %}');
    expect(template).toContain('id="presence-bar"');
    expect(template).toContain('data-page-id="{{ cmsEditPresence.pageId }}"');
    expect(template).toContain('data-user-id="{{ cmsEditPresence.currentUserId }}"');
    expect(template).toContain('id="presence-avatars"');
    expect(template).toContain('id="sync-indicator"');
  });

  it('offers Unpublish (not Publish) once the form is live', async () => {
    stubLiveStatus(true);
    const { data } = await clientViewData(await plugin.fetch(editRequest(editContext()), env()));
    expect(data.published).toBe(true);
    expect(data.unpublishAction).toContain('/admin/pages/301/unpublish');
  });

  it('falls back to Publish when the live state cannot be read', async () => {
    // No CMS stub: the probe fetch fails, so the editor must not guess Unpublish.
    stubCms(() => null);
    const { data } = await clientViewData(await plugin.fetch(editRequest(editContext()), env()));
    expect(data.published).toBe(false);
    expect(data.unpublishAction).toBe('');
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

/** A form exercising every question type the editor can configure. */
function richLect(): Record<string, unknown> {
  const lect = formLect();
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
  return lect;
}

describe('question types', () => {
  it('expands a grid question to one submissions column per row', async () => {
    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301') {
        return Response.json({ page: cmsFormPage({ lect: richLect() }) });
      }
      if (method === 'GET' && url.pathname === '/__cms/pages' && url.searchParams.get('page_type') === 'form_submission') {
        return Response.json({
          pages: [{
            id: 900, page_type: 'form_submission', name: 'Ada', page_id: 301,
            lect: { name: 'Ada', answers: { 'form-venue__food': 'good', 'form-venue__seating': 'bad' } },
          }],
          total: 1,
        });
      }
      return null;
    });

    const csv = await (await plugin.fetch(adminRequest('/__plugin/admin/forms/301/export'), env())).text();
    // Answer keys must match what worker-form stores: one per grid ROW.
    expect(csv).toContain('Rate the venue — Food');
    expect(csv).toContain('Rate the venue — Seating');
    expect(csv).toContain('good');
    expect(csv).toContain('bad');
  });

  it('offers every new type in the editor and shows its config panel', async () => {
    const lect = richLect();
    stubCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/301') return Response.json({ page: { ...cmsFormPage(), isPublished: false } });
      return null;
    });
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
    const { data } = await clientViewData(response);
    const blocks = data.blocks as Array<{ questions?: Array<Record<string, unknown>> }>;
    const questions = blocks[0]?.questions ?? [];
    const labels = questions.flatMap((question) =>
      (question.typeOptions as Array<{ label: string }>).map((option) => option.label));
    expect(labels).toEqual(expect.arrayContaining([
      'Checkboxes',
      'File upload',
      'Linear scale',
      'Rating',
      'Multiple choice grid',
      'Checkbox grid',
    ]));
    // Grid question: options panel is relabelled "Columns" and gains Rows.
    expect(questions[3]).toMatchObject({
      isGrid: true,
      optionsLabel: 'Columns',
      rowsName: '#0.custom_input[3].rows|mis',
      rowsValue: 'Food\nSeating',
    });
    // Scale bounds and labels, rating stars, file constraints.
    expect(questions[1]).toMatchObject({
      minName: '#0.custom_input[1]@min',
      maxLabelName: '#0.custom_input[1].max_label|mis',
    });
    expect(questions[2]).toMatchObject({ maxName: '#0.custom_input[2]@max' });
    expect(questions[5]).toMatchObject({
      acceptName: '#0.custom_input[5]@accept',
      maxSizeName: '#0.custom_input[5]@max_size',
    });
    // Config a question's type doesn't currently show still round-trips.
    expect(questions[0]).toMatchObject({ rowsName: '#0.custom_input[0].rows|mis' });
  });
});

// ── File uploads ──────────────────────────────────────────────────────────────

/** Minimal in-memory R2 stand-in covering put/get + writeHttpMetadata. */
function fakeBucket() {
  const objects = new Map<string, { body: string; contentType: string }>();
  const bucket = {
    async put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { body: value, contentType: options?.httpMetadata?.contentType ?? '' });
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

describe('file upload answers', () => {
  /** A form whose only question is a file upload, as the editor stores it. */
  function fileLect(): Record<string, unknown> {
    const lect = formLect();
    lect._blocks = [{
      _id: 'questions',
      _type: 'form-inputs',
      _weight: 1,
      custom_input: [{ name: 'cv', type: 'file', required: 'no', label: { mis: 'CV' }, accept: 'pdf', max_size: '5' }],
    }];
    return lect;
  }

  /** worker-form's key layout: `form-<id>/<uuid>-<filename>`. */
  const storedKey = 'form-301/11111111-2222-3333-4444-555555555555-cv.pdf';

  it('serves a stored file to the admin and refuses another form\'s key', async () => {
    const { bucket } = fakeBucket();
    await bucket.put(storedKey, '%PDF-1.4 hello' as never, { httpMetadata: { contentType: 'application/pdf' } });
    const key = storedKey;

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
    const key = storedKey;
    const lect = fileLect();
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
    const html = await clientViewContractText(table);
    expect(html).toContain('/admin/plugins/form/forms/301/files/form-301/');
    expect(html).toContain('cv.pdf');

    const csv = await (await plugin.fetch(adminRequest('/__plugin/admin/forms/301/export'), env())).text();
    // The CSV carries the human filename, never the internal storage key.
    expect(csv).toContain('cv.pdf');
    expect(csv).not.toContain('11111111-2222');
  });
});
