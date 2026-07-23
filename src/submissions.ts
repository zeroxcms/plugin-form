// ============================================================
// Submission writes — the ONLY writes this Worker makes to the published D1
// (PUBLISHED_DB, otherwise read-only; see published.ts).
//
// Public form submits are stored as insert-only rows in `live_pages`:
//
//   form_submission — one row per submit; page_id = the form's id
//
// Ownership contract with worker-cms (its src/publish/README.md):
//   - INSERT only — never UPDATE or DELETE, and never touch rows whose
//     uuids the CMS minted, so a republish can never overwrite a submission
//     and a submission can never corrupt published content.
//   - ids are NEGATIVE (CMS page ids are positive, minted from the same
//     timestamp formula — the sign makes a collision impossible).
//   - uuids come from the table default; worker-cms treats any live-only uuid
//     as a submission, mirrors it into draft, and fires `submission` hooks.
// ============================================================

import type { CmsPage } from './cms';

export const SUBMISSION_PAGE_TYPE = 'form_submission';

/** Mirrors the CMS id formula, negated: -((epoch_s - offset) * 100000 + rand16). */
const CMS_ID_EPOCH_OFFSET = 1563741060;

function mintSubmissionId(): number {
  const seconds = Math.floor(Date.now() / 1000) - CMS_ID_EPOCH_OFFSET;
  const random = crypto.getRandomValues(new Uint16Array(1))[0];
  return -(seconds * 100000 + random);
}

export interface FormSubmission {
  form: CmsPage;
  name: string;
  email: string;
  language: string;
  /** Every `form-*` custom-input field, verbatim (see fields.ts collectAnswers). */
  answers: Record<string, string>;
}

export async function insertFormSubmission(db: D1Database, submission: FormSubmission): Promise<void> {
  const submittedAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO live_pages (id, name, slug, weight, page_type, lect, page_id)
     VALUES (?, ?, ?, 5, ?, ?, ?)`,
  )
    .bind(
      mintSubmissionId(),
      submission.name || `Submission — ${submission.form.name}`,
      `submission-${submission.form.id}-${Date.now()}`,
      SUBMISSION_PAGE_TYPE,
      JSON.stringify({
        _type: SUBMISSION_PAGE_TYPE,
        form_id: String(submission.form.id),
        name: submission.name,
        email: submission.email,
        language: submission.language,
        submitted_at: submittedAt,
        answers: submission.answers,
      }),
      submission.form.id,
    )
    .run();
}
