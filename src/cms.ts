// ============================================================
// Form Builder CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in
// @lionrockjs/worker-cms-plugin. This file keeps the plugin's imports stable
// and adds only the form-specific extensions that do not belong in the
// generic SDK (submission ingest and bulk teardown).
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

  constructor(env: CmsClientEnv) {
    super(env, PLUGIN_ID);
    this.link = { base: (env.CMS_URL ?? '').replace(/\/+$/, ''), secret: env.PLUGIN_SECRET ?? '' };
  }

  /** Authentication headers for this class's own raw /__cms fetches. */
  private linkHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-plugin-secret': this.link.secret,
      'x-plugin-id': PLUGIN_ID,
      ...extra,
    };
  }

  /**
   * One page plus whether it is currently live (CMS
   * `GET /pages/:id?include_live_status=1`). The base client's `get` omits the
   * flag, and the editor needs it: a form that is not in `live_pages` is
   * invisible to worker-form, so the editor must offer Publish rather than
   * Unpublish.
   */
  async getWithLiveStatus(id: number): Promise<CmsPage & { isPublished: boolean }> {
    const path = `/pages/${id}?include_live_status=1`;
    const response = await globalThis.fetch(`${this.link.base}/__cms${path}`, { headers: this.linkHeaders() });
    if (!response.ok) {
      const code = await response.text().then((text) => text.trim().slice(0, 160) || 'error').catch(() => 'error');
      throw new CmsApiError(response.status, code, 'GET', path);
    }
    const { page } = await response.json() as { page: CmsPage & { isPublished?: boolean } };
    return { ...page, isPublished: page.isPublished === true };
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
