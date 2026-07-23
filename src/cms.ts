// ============================================================
// Form Builder CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in
// @lionrockjs/worker-cms-plugin. This file keeps the plugin's imports stable
// and adds only the form-specific extensions that do not belong in the
// generic SDK (acting-user attribution, submission ingest, bulk teardown).
// Mirrors cms-plugin-events/src/cms.ts.
// ============================================================

import {
  CmsClient as BaseCmsClient,
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  blocks,
  compareByWeightThenName,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsListPointer,
  type CmsPage,
  type CmsPageInput,
} from '@lionrockjs/worker-cms-plugin';

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'form';

/**
 * Page type of one response. worker-form INSERTs these rows into the
 * published D1 as visitors submit; the host mirrors each one into a draft
 * page (firing this plugin's `submission` hook), which is the only form the
 * admin ever reads. Must stay in step with worker-form/src/submissions.ts.
 */
export const SUBMISSION_PAGE_TYPE = 'form_submission';

export {
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  blocks,
  compareByWeightThenName,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsListPointer,
  type CmsPage,
  type CmsPageInput,
};

/**
 * Selects a related collection of pages for the bulk delete operation.
 * Submissions hang off their form by parent page id (page_id = form id).
 */
export type CollectionSelector =
  | { pointerKey: string; pointerValue: string }
  | { parentPageId: number };

function selectorFields(selector: CollectionSelector): Record<string, unknown> {
  return 'pointerKey' in selector
    ? { pointer_key: selector.pointerKey, pointer_value: selector.pointerValue }
    : { page_id: selector.parentPageId };
}

export class CmsClient extends BaseCmsClient {
  /** The base `call`/`json` are private, so the raw /__cms fetches below keep their own copy of the link config. */
  private readonly link: { base: string; secret: string };
  private actingUserId: string | null = null;

  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      // The wrapper adds x-acting-user-id (when set) to every base-client
      // call, so the host can charge credit costs to the signed-in admin.
      fetcher: (input, init) => globalThis.fetch(input, this.withActingUser(init)),
    });
    this.link = { base: (env.CMS_URL ?? '').replace(/\/+$/, ''), secret: env.PLUGIN_SECRET ?? '' };
  }

  /**
   * Attributes subsequent CMS calls to the signed-in admin (from the
   * `x-cms-user` summary the host forwards), so host-side credit costs are
   * charged to them. Flows with no user (public form, hooks) stay unset.
   */
  actAs(userId: string | number | null | undefined): this {
    this.actingUserId = userId === null || userId === undefined || userId === '' ? null : String(userId);
    return this;
  }

  private withActingUser(init?: RequestInit): RequestInit {
    if (!this.actingUserId) return init ?? {};
    const headers = new Headers(init?.headers);
    headers.set('x-acting-user-id', this.actingUserId);
    // Plain object (not a Headers instance) so callers and tests that inspect
    // init.headers by key keep working.
    return { ...init, headers: Object.fromEntries(headers.entries()) };
  }

  /** Auth + attribution headers for this class's own raw /__cms fetches. */
  private linkHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-plugin-secret': this.link.secret,
      'x-plugin-id': PLUGIN_ID,
      ...(this.actingUserId ? { 'x-acting-user-id': this.actingUserId } : {}),
      ...extra,
    };
  }

  /**
   * Asks the host to pull live-only submission rows (published DB → draft
   * pages) NOW instead of waiting for its cron tick (CMS
   * `POST /__cms/ingest/submissions`). Idempotent and bounded per call; each
   * created page fires this plugin's `submission` hook.
   */
  async ingestSubmissions(): Promise<{ scanned: number; created: number; more: boolean }> {
    const response = await globalThis.fetch(`${this.link.base}/__cms/ingest/submissions`, {
      method: 'POST',
      headers: this.linkHeaders(),
    });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'POST', '/ingest/submissions');
    }
    return await response.json() as { scanned: number; created: number; more: boolean };
  }

  /**
   * Server-side bulk soft-delete of a related collection (CMS `DELETE
   * /pages/children`). Trashes the work in the CMS Worker — no child ids
   * stream back to the plugin — and repeats while the host reports more
   * remain. Returns the total trashed. Never bulk-delete a whole child
   * collection with batchRemove (per-page unpublish fanout hangs big sets).
   */
  async deleteChildren(selector: CollectionSelector, pageType: string): Promise<number> {
    let total = 0;
    for (;;) {
      const response = await globalThis.fetch(`${this.link.base}/__cms/pages/children`, {
        method: 'DELETE',
        headers: this.linkHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ...selectorFields(selector), page_type: pageType }),
      });
      if (!response.ok) {
        const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
        throw new CmsApiError(response.status, code, 'DELETE', '/pages/children');
      }
      const result = await response.json() as { trashed: number; done: boolean };
      total += result.trashed;
      // Guard against a non-progressing response (nothing trashed yet not done).
      if (result.done || result.trashed === 0) break;
    }
    return total;
  }
}
