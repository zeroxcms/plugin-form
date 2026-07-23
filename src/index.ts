// ============================================================
// Worker CMS plugin — "form" builder.
//
// A Google-Forms-style form builder on the 0xCMS plugin contract, reusing the
// events-suite blueprint: forms are CMS pages built from blocks (the
// `custom_input` item shape ported from the RSVP form) and the admin UI is a
// set of client-view fragments wrapped in the host admin chrome.
//
// This Worker is the ADMIN side only. Visitors are served by worker-form, a
// separate Worker on its own domain that reads published forms from the CMS's
// published D1 and INSERTs responses back into it (the worker-rsvp posture);
// worker-cms ingests those rows and fires this plugin's `submission` hooks.
// ============================================================

import {
  CmsClient,
  CmsApiError,
  CmsNotConfiguredError,
} from './cms';
import { handleFormEditView } from './edit-view';
import { handleFormsAdmin, type FormsEnv } from './forms';
import { cmsUserId, formAdminAccessForRequest, forbidden } from './permissions';
import { adminView } from './templates/views';
import {
  redirect,
  requireTenant,
  serveViewAsset,
  tenantClientEnv,
} from '@lionrockjs/worker-cms-plugin';
// The plugin manifest (content types, blocks, nav, hooks) is plain data, so it
// lives as a static JSON file served verbatim at /__plugin/manifest rather
// than being assembled from constants here.
import MANIFEST from './manifest.json';

interface PluginEnv extends FormsEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the Plugin API write-back API). */
  CMS_URL?: string;
  /** Multi-tenant registry: `tenant:<cms origin>` → TenantConfig JSON. When
   *  unbound, CMS_URL + PLUGIN_SECRET form the single legacy tenant. */
  TENANTS?: KVNamespace;
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
  /** Deploy identifier exposed in the manifest to invalidate cached views. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export default {
  async fetch(request: Request, baseEnv: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Secret-authenticated host calls resolve their tenant (x-cms-tenant +
    // x-plugin-secret verified against the SAME registry row), then all
    // downstream code runs against a tenant-scoped env: CMS_URL/PLUGIN_SECRET
    // become that tenant's pair, so every CmsClient built from `env` is bound
    // to the calling CMS and cannot touch another tenant's data.
    let env = baseEnv;
    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/admin')
      || path === '/__plugin/edit';
    if (secretRequired) {
      const tenant = await requireTenant(request, baseEnv);
      if (tenant instanceof Response) return tenant;
      env = tenantClientEnv(baseEnv, tenant) as PluginEnv;
    }

    if (path === '/__plugin/manifest') {
      return Response.json({
        ...MANIFEST,
        ...(baseEnv.CF_VERSION_METADATA ? { workerVersion: baseEnv.CF_VERSION_METADATA } : {}),
      });
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver
    // so plugin field/block renderers resolve inside the native CMS page editor.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    // Static assets declared in the plugin manifest (none yet, kept for parity).
    if (path.startsWith('/assets/')) {
      return serveViewAsset(env.VIEWS, path);
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const hookEvent = path.split('/').pop();
      const payload = await request.json().catch(() => ({})) as { page?: unknown; pages?: unknown[] };
      const pages = Array.isArray(payload.pages) ? payload.pages : payload.page !== undefined ? [payload.page] : [];
      // Submission mirrors need no write-back (the admin reads them as pages);
      // the hook is acknowledged so host deliveries don't retry.
      console.log(`[form-builder] hook ${hookEvent}: ${pages.length} page(s)`);
      return new Response('ok');
    }

    // Plugin-rendered page editor (manifest `editViews: ["form"]`). The CMS
    // POSTs the editor context; we return the Google-Forms-style editor as a
    // client view the CMS wraps in its admin chrome. The editor's form posts
    // back to the CMS's own save handler, so no CMS client is needed here.
    if (path === '/__plugin/edit' && request.method === 'POST') {
      const access = formAdminAccessForRequest(request);
      if (!access.canEdit) return forbidden();
      return handleFormEditView(request);
    }

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url);
    }

    // Visitors belong to worker-form (PUBLIC_BASE_URL), not here.
    return new Response('not found', { status: 404 });
  },
};

// ── Admin router ──────────────────────────────────────────────────────────────

function wantsJson(url: URL): boolean {
  const json = url.searchParams.get('json')?.trim().toLowerCase();
  const format = url.searchParams.get('format')?.trim().toLowerCase();
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}

/** Renders an error panel when the CMS link is unconfigured or returns an error. */
function errorPanel(views: Fetcher, message: string, showConfig = false, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Error', 'error', { message, showConfig }, jsonOnly);
}

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'forms';
  const jsonOnly = wantsJson(url);

  if (section === 'assets') {
    return serveViewAsset(env.VIEWS, `/assets/${segments.slice(1).join('/')}`);
  }
  if (section === 'views') {
    const viewPath = `/${segments.slice(1).join('/')}`;
    if (viewPath.startsWith('/snippets/pagefield/')) {
      return redirect(`/admin/views${viewPath}${url.search}`);
    }
    return serveViewAsset(env.VIEWS, viewPath, { bareLiquidSnippets: true });
  }

  let cms: CmsClient;
  try {
    // Attribute all CMS writes in this request to the signed-in admin, so
    // host-side credit costs land on their balance.
    cms = new CmsClient(env).actAs(cmsUserId(request));
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message, true, jsonOnly);
    throw error;
  }

  const access = formAdminAccessForRequest(request);
  if (!access.canView) return forbidden();

  // Each handler is `await`ed (not bare-returned) so a CmsApiError it throws
  // is caught below and rendered as an error panel rather than escaping this
  // function as an unhandled 500.
  try {
    // section === 'forms' (the only nav section)
    return await handleFormsAdmin(request, cms, env, segments.slice(1), url, jsonOnly, access);
  } catch (error) {
    if (error instanceof CmsApiError) {
      // The host rejects creates that would cross an admin-configured quota
      // (Plugins → Limits) with 409 limit_exceeded. Nothing was written.
      if (error.code === 'limit_exceeded') {
        return errorPanel(
          env.VIEWS,
          'A configured limit has been reached, so nothing was created. Remove existing items, or ask an administrator to raise the limit under Plugins → Limits.',
          false,
          jsonOnly,
        );
      }
      if (error.code === 'insufficient_credits') {
        return errorPanel(
          env.VIEWS,
          'You do not have enough credits for this action, so nothing was changed. Check your balance on your profile page, or ask an administrator to top it up.',
          false,
          jsonOnly,
        );
      }
      const target = error.method && error.path ? ` ${error.method} ${error.path}` : '';
      return errorPanel(env.VIEWS, `CMS responded${target} ${error.status} (${error.code}).`, false, jsonOnly);
    }
    throw error;
  }
}
