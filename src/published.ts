// ============================================================
// Published-content reader (worker-rsvp / worker-web pattern).
//
// The public form reads the SAME D1 database the CMS publishes to
// (`cms-published` → `live_pages`), bound here as PUBLISHED_DB. This module
// only ever issues parameterized SELECTs; the schema is owned and migrated by
// worker-cms. The binding's only writes live in src/submissions.ts —
// insert-only form_submission rows with negative ids, per the generic
// live-only submission contract in worker-cms src/publish/README.md. Draft
// pages (and the Plugin API) are never touched on the public path: a form
// that is not published is simply not visible.
// ============================================================

import type { CmsPage } from './cms';

export interface PublishedEnv {
  PUBLISHED_DB?: D1Database;
}

interface LivePageRow {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_type: string | null;
  lect: string | null;
  page_id: number | null;
}

const PAGE_COLUMNS =
  'id, uuid, created_at, updated_at, name, slug, weight, start, end, timezone, page_type, lect, page_id';

/** One published page by id, mapped to the CmsPage shape the lect helpers read. */
export async function getPublishedPage(db: D1Database, id: number): Promise<CmsPage | null> {
  const row = await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM live_pages WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<LivePageRow>();
  return row ? rowToPage(row) : null;
}

/** One published page by type + slug, used by the public /f/<slug> route. */
export async function getPublishedPageBySlug(db: D1Database, pageType: string, slug: string): Promise<CmsPage | null> {
  const row = await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM live_pages WHERE page_type = ? AND slug = ? LIMIT 1`)
    .bind(pageType, slug)
    .first<LivePageRow>();
  return row ? rowToPage(row) : null;
}

function rowToPage(row: LivePageRow): CmsPage {
  return {
    id: row.id,
    uuid: row.uuid,
    page_type: row.page_type,
    name: row.name,
    slug: row.slug,
    weight: row.weight,
    start: row.start,
    end: row.end,
    timezone: row.timezone,
    page_id: row.page_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lect: parseLect(row.lect),
  };
}

function parseLect(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
