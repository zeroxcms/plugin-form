// ============================================================
// Worker CMS plugin — "form" builder.
//
// A Google-Forms-style form builder on the 0xCMS plugin contract, reusing the
// events-suite blueprint: forms are CMS pages built from blocks (the
// `custom_input` item shape ported from the RSVP form), the admin UI is a set
// of client-view fragments wrapped in the host admin chrome, and the public
// form site lives on this same Worker (/f/<slug>) reading the published D1 —
// the worker-rsvp posture, including INSERT-only submission rows that
// worker-cms ingests and fires `submission` hooks for.
// ============================================================

import {
  CmsClient,
  CmsApiError,
  CmsNotConfiguredError,
} from './cms';
import { ADMIN_BASE, handleFormsAdmin, type FormsEnv } from './forms';
import { cmsUserId, formAdminAccessForRequest, forbidden } from './permissions';
import { handlePublicForm, type PublicEnv } from './public';
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

interface PluginEnv extends FormsEnv, PublicEnv {
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
      || path.startsWith('/__plugin/admin');
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

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url);
    }

    // ── Public form site (own domain) ──────────────────────────────────────
    const publicForm = await handlePublicForm(request, env, url);
    if (publicForm) return withSecurityHeaders(publicForm);

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

// worker-rsvp posture for the public pages: strict headers, inline styles only.
function withSecurityHeaders(response: Response): Response {
  const wrapped = new Response(response.body, response);
  const headers = wrapped.headers;
  headers.set('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return wrapped;
}
