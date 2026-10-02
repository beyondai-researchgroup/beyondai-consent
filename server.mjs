// Local API server for the Consent app: participant lookup + consent submission (which sets
// Participant.Language/ConsentGivenAt, issues 24h-expiring REI-40/Big Five access tokens, and
// emails both links). Talks directly to the shared Neon Postgres DB, same pattern as
// REI-40/Big Five's own server.mjs. Run with `node --env-file=.env server.mjs`.

import express from 'express';
import cors from 'cors';
import { neon } from '@neondatabase/serverless';
import { sendMail } from './server/email/mailer.mjs';
import { buildConsentEmail } from './server/email/consentEmail.mjs';
import { buildThankYouEmail } from './server/email/thankYouEmail.mjs';
import { DEFAULT_CONSENT_SECTIONS, DEFAULT_CHECKBOX_TEXT_SR, DEFAULT_CHECKBOX_TEXT_EN } from './server/consent-defaults.mjs';
import { issueSurveyLinks, resolveOrIssuePortalLinks } from './server/tokens/issueSurveyLinks.mjs';
import { createLocalSql } from './server/local-db.mjs';

const PORT = process.env.PORT || 4313;

// Dual-mode (2026-09-08) — DB_MODE=local (.env.local, npm run serve:api:local) swaps in a local
// Postgres client; see local-db.mjs's header comment and docs/local-dev-database.md (in
// admin-dashboard-andrejkatin, the DB these two apps share is documented there). Plain
// `npm run serve:api` (.env, DATABASE_URL, no DB_MODE) is untouched — always neon().
let dbClient;
function getDb() {
  if (!dbClient) {
    if (process.env.DB_MODE === 'local') {
      const url = process.env.LOCAL_DATABASE_URL;
      if (!url) throw new Error('LOCAL_DATABASE_URL environment variable is not set (DB_MODE=local)');
      dbClient = createLocalSql(url);
      console.log('[db] developer mode: local Postgres');
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL environment variable is not set');
      dbClient = neon(url);
    }
  }
  return dbClient;
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

// 2026-09-09 — Activate/Deactivate portal toggle (admin-dashboard-andrejkatin's Consent Form →
// Delivery page, PUT /api/admin/consent-form/:researchId/portal-active). A fresh research starts
// inactive (Research.ConsentPortalActive DEFAULT FALSE); this is the gate that keeps a
// not-yet-activated /r/:slug link from letting anyone through. Used both by /api/research/:slug
// itself (the actual entry point) and, for defense in depth, by every scoped participant-facing
// call below that already knows its researchId — closes the gap where a client resolved the
// research before a researcher deactivated it mid-session.
async function isPortalActive(sql, researchId) {
  const rows = await sql`SELECT "ConsentPortalActive" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
  return rows.length > 0 && rows[0].ConsentPortalActive === true;
}

// Phase C of platform-ification: the Consent Form is now per-research (ConsentSection rows +
// Research.ConsentCheckboxText*), configured through the Admin Dashboard's "Consent Form" page
// instead of this app's old fixed CONSENT.SECTION*/CHECKBOX_LABEL i18n text. Lazily seeds the
// same defaults that text used to be, so a research nobody has configured yet (or one created
// before this shipped) still shows a complete, sensible form instead of an empty one — same
// auto-seed-on-first-read logic as admin-dashboard-andrejkatin's server/consent-sections/routes.mjs
// (duplicated, not shared — see consent-defaults.mjs's header comment).
async function seedDefaultsIfEmpty(sql, researchId) {
  const existing = await sql`SELECT 1 FROM "ConsentSection" WHERE "ResearchId" = ${researchId} LIMIT 1`;
  if (existing.length) return;
  for (let i = 0; i < DEFAULT_CONSENT_SECTIONS.length; i++) {
    const s = DEFAULT_CONSENT_SECTIONS[i];
    await sql`
      INSERT INTO "ConsentSection" ("ResearchId", "SortOrder", "TitleSr", "TitleEn", "BodySr", "BodyEn")
      VALUES (${researchId}, ${i}, ${s.titleSr}, ${s.titleEn}, ${s.bodySr}, ${s.bodyEn})
    `;
  }
  await sql`
    UPDATE "Research" SET
      "ConsentCheckboxTextSr" = COALESCE("ConsentCheckboxTextSr", ${DEFAULT_CHECKBOX_TEXT_SR}),
      "ConsentCheckboxTextEn" = COALESCE("ConsentCheckboxTextEn", ${DEFAULT_CHECKBOX_TEXT_EN})
    WHERE "Id" = ${researchId}
  `;
}

async function getConsentFormFor(sql, researchId) {
  if (researchId == null) {
    // No research assigned to this participant (e.g. a pre-Phase-A/B row, or the unused
    // classic-loader flow) — fall back to the original fixed defaults rather than failing, so
    // the Consent app never breaks for a participant with no ResearchId on file.
    return {
      consentSections: DEFAULT_CONSENT_SECTIONS,
      checkboxTextSr: DEFAULT_CHECKBOX_TEXT_SR,
      checkboxTextEn: DEFAULT_CHECKBOX_TEXT_EN,
    };
  }
  await seedDefaultsIfEmpty(sql, researchId);
  const sections = await sql`
    SELECT "TitleSr", "TitleEn", "BodySr", "BodyEn" FROM "ConsentSection"
    WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder"
  `;
  const research = await sql`
    SELECT "ConsentCheckboxTextSr", "ConsentCheckboxTextEn" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1
  `;
  return {
    consentSections: sections.map((s) => ({
      titleSr: s.TitleSr, titleEn: s.TitleEn, bodySr: s.BodySr, bodyEn: s.BodyEn,
    })),
    checkboxTextSr: research[0]?.ConsentCheckboxTextSr ?? DEFAULT_CHECKBOX_TEXT_SR,
    checkboxTextEn: research[0]?.ConsentCheckboxTextEn ?? DEFAULT_CHECKBOX_TEXT_EN,
  };
}

// Shared by both GET /api/participant/:id and GET /api/link/:token (2026-09-08 follow-up) —
// same "does this participant need consent text, and in which language(s)" payload shape,
// resolved from whichever row lookup found them. Part E's UsesConsentForm=false short-circuit
// (skip seeding/fetching ConsentSection entirely) applies identically either way.
async function buildParticipantCheckPayload(sql, { researchId, language, consentGivenAt, usesConsentForm, consentLanguageSr, consentLanguageEn, isTestParticipant }) {
  const consentForm = usesConsentForm ? await getConsentFormFor(sql, researchId) : {};
  return {
    exists: true,
    // A test participant always sees the consent form again, never the "already done" /done
    // screen — the whole point of a repeatable test participant is being able to redo this.
    alreadyConsented: isTestParticipant ? false : consentGivenAt !== null,
    language: language ?? null,
    usesConsentForm,
    consentLanguages: { sr: consentLanguageSr, en: consentLanguageEn },
    // 2026-09-08 follow-up — lets the frontend thread ResearchId into its next scoped call
    // (checkParticipant already knows it if resolved via /r/:slug, but this also covers the bare
    // /login path, where it's only known AFTER the lookup succeeds).
    researchId: researchId ?? null,
    ...consentForm,
  };
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

// Resolves a research-scoped Consent entry point's path segment (2026-09-08 follow-up —
// per-research delivery links, admin-dashboard-andrejkatin's server/consent-form/mailing-list.mjs
// portal-link route builds these). LoginComponent's /r/:slug route calls this first, then threads
// the resolved id into checkParticipant/submitConsent/issueLinks below so every one of those can
// scope its own Participant lookup — the ambiguity check just below stays as the fallback for the
// bare, unscoped /login path only.
app.get('/api/research/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (!isNonEmptyString(slug, 80)) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  try {
    const sql = getDb();
    const rows = await sql`SELECT "Id", "Name", "ConsentPortalActive" FROM "Research" WHERE "Slug" = ${slug} LIMIT 1`;
    if (!rows.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (rows[0].ConsentPortalActive !== true) {
      res.status(403).json({ error: 'NOT_ACTIVE' });
      return;
    }
    res.json({ id: rows[0].Id, name: rows[0].Name });
  } catch (err) {
    console.error('[DB] research resolve error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Scoped lookup shared by GET /api/participant/:id and (indirectly, via participantId) the
// consent/submit and links/issue handlers below. When researchId is given, the WHERE clause adds
// the research filter — since (ResearchId, ParticipantId) is the real unique key on Participant,
// a scoped lookup can never return more than one row, so the AMBIGUOUS_PARTICIPANT_ID branch is
// structurally unreachable on a research-scoped call; it stays reachable only for the unscoped
// (bare /login, no researchId) case.
async function lookupParticipantRows(sql, participantId, researchId) {
  if (researchId != null) {
    return sql`
      SELECT p."Language", p."ConsentGivenAt", p."ResearchId", p."IsTestParticipant", COALESCE(r."UsesConsentForm", TRUE) AS "UsesConsentForm",
             COALESCE(r."ConsentLanguageSr", TRUE) AS "ConsentLanguageSr", COALESCE(r."ConsentLanguageEn", TRUE) AS "ConsentLanguageEn"
      FROM "Participant" p
      LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
      WHERE p."ParticipantId" = ${participantId} AND p."ResearchId" = ${researchId}
    `;
  }
  return sql`
    SELECT p."Language", p."ConsentGivenAt", p."ResearchId", p."IsTestParticipant", COALESCE(r."UsesConsentForm", TRUE) AS "UsesConsentForm",
           COALESCE(r."ConsentLanguageSr", TRUE) AS "ConsentLanguageSr", COALESCE(r."ConsentLanguageEn", TRUE) AS "ConsentLanguageEn"
    FROM "Participant" p
    LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
    WHERE p."ParticipantId" = ${participantId}
  `;
}

function parseOptionalResearchId(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

app.get('/api/participant/:id', async (req, res) => {
  const id = req.params.id;
  if (!isNonEmptyString(id, 50)) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }
  const parsedResearchId = parseOptionalResearchId(req.query.researchId);
  if (!parsedResearchId.ok) {
    res.status(400).json({ error: 'Invalid researchId' });
    return;
  }
  try {
    const sql = getDb();
    // 2026-09-09 defense in depth — see isPortalActive's header comment. Only applies to the
    // scoped (researchId-known) path; the bare /login flow has no portal to gate.
    if (parsedResearchId.value != null && !(await isPortalActive(sql, parsedResearchId.value))) {
      res.status(403).json({ error: 'NOT_ACTIVE' });
      return;
    }
    // Item 1 of admin-dashboard-andrejkatin's "platform improvements round 2" plan —
    // ParticipantId is scoped per research now, not globally unique. When this request came in
    // through a research-scoped /r/:slug link, researchId is already known and the lookup below
    // is scoped by it (see lookupParticipantRows) — a genuine collision is then structurally
    // impossible. The bare /login path (no researchId) keeps today's behavior: a collision fails
    // loud instead of silently resolving whichever row happened to come back first.
    const rows = await lookupParticipantRows(sql, id, parsedResearchId.value);
    if (rows.length > 1) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!rows.length) {
      res.json({ exists: false, alreadyConsented: false, language: null, usesConsentForm: true, consentLanguages: { sr: true, en: true } });
      return;
    }
    const r = rows[0];
    // The bare-id form (/login, /r/:slug) is test-participants-only now — every real participant
    // arrives exclusively via their emailed magic link (/api/link/:token below), which never hits
    // this check since it's already proof of authorization on its own.
    if (!r.IsTestParticipant) {
      res.status(403).json({ error: 'PERSONAL_LINK_REQUIRED' });
      return;
    }
    res.json(
      await buildParticipantCheckPayload(sql, {
        researchId: r.ResearchId, language: r.Language, consentGivenAt: r.ConsentGivenAt,
        usesConsentForm: r.UsesConsentForm, consentLanguageSr: r.ConsentLanguageSr, consentLanguageEn: r.ConsentLanguageEn,
        isTestParticipant: true,
      })
    );
  } catch (err) {
    console.error('[DB] participant check error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Magic-link resolution (Part C3 of the 2026-09-08 follow-up round) — a mailing-list recipient
// clicks their emailed link instead of typing a Participant ID; this resolves the same payload
// shape as GET /api/participant/:id above, plus the resolved participantId itself so the
// frontend can proceed exactly as if that id had been typed in. Joins on ParticipantGuid, not
// the bare ParticipantId, matching every other magic-link handler in this codebase (REI-40/Big
// Five/NASA-TLX) — the Token itself already uniquely resolves the participant.
app.get('/api/link/:token', async (req, res) => {
  const token = req.params.token;
  if (!isNonEmptyString(token, 64)) {
    res.status(400).json({ error: 'Invalid token' });
    return;
  }
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT sat."ParticipantId", sat."ExpiresAt", p."ResearchId", p."Language", p."ConsentGivenAt",
             COALESCE(r."UsesConsentForm", TRUE) AS "UsesConsentForm",
             COALESCE(r."ConsentLanguageSr", TRUE) AS "ConsentLanguageSr",
             COALESCE(r."ConsentLanguageEn", TRUE) AS "ConsentLanguageEn"
      FROM "SurveyAccessToken" sat
      JOIN "Participant" p ON p."Guid" = sat."ParticipantGuid"
      LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
      WHERE sat."Token" = ${token} AND sat."SurveyType" = 'CONSENT_ENTRY'
      LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const row = rows[0];
    if (new Date(row.ExpiresAt) < new Date()) {
      res.status(410).json({ error: 'EXPIRED' });
      return;
    }
    // 2026-09-09 master pause switch — Mode 2 (mailing-list) recipients already hold a real
    // token, but the research they're entering can still have been paused after that token was
    // minted (or the mint-side check in mailing-list.mjs was bypassed by an older token). Same
    // isPortalActive gate the other 4 endpoints in this file already use.
    if (row.ResearchId != null && !(await isPortalActive(sql, row.ResearchId))) {
      res.status(403).json({ error: 'NOT_ACTIVE' });
      return;
    }
    const payload = await buildParticipantCheckPayload(sql, {
      researchId: row.ResearchId, language: row.Language, consentGivenAt: row.ConsentGivenAt,
      usesConsentForm: row.UsesConsentForm, consentLanguageSr: row.ConsentLanguageSr, consentLanguageEn: row.ConsentLanguageEn,
    });
    // payload's own `researchId` (see buildParticipantCheckPayload) is what the frontend threads
    // into its next scoped call — closes the same latent ambiguity gap for magic-link visitors
    // too, not just /r/:slug ones (see lookupParticipantRows's comment).
    res.json({ participantId: row.ParticipantId, ...payload });
  } catch (err) {
    console.error('[DB] link resolve error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

async function lookupConsentSubmitRows(sql, participantId, researchId) {
  if (researchId != null) {
    return sql`
      SELECT p."Email", p."Language", p."ResearchId", p."GenericTaskId", p."IsTestParticipant", r."UsesPsychTests", r."UsesTlx", r."TaskType", r."StudyDisplayName", r."Name" AS "ResearchName", r."EmailSenderName", r."UsesDemographics"
      FROM "Participant" p
      LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
      WHERE p."ParticipantId" = ${participantId} AND p."ResearchId" = ${researchId}
    `;
  }
  return sql`
    SELECT p."Email", p."Language", p."ResearchId", p."GenericTaskId", p."IsTestParticipant", r."UsesPsychTests", r."UsesTlx", r."TaskType", r."StudyDisplayName", r."Name" AS "ResearchName", r."EmailSenderName", r."UsesDemographics"
    FROM "Participant" p
    LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
    WHERE p."ParticipantId" = ${participantId}
  `;
}

// NASA-TLX for a PR_REVIEW research is delivered exclusively via the Code Review AI app's own
// decision -> NASA-TLX handoff (AppComponent.onDecisionSubmitted, a window.location.href redirect
// straight after a review decision is submitted) — never through a standalone magic-link/email.
// The standalone NASA-TLX module (Part D of the platform re-architecture, 2026-09-07) only applies
// to a research with no code-review-ai flow at all (e.g. a pure Google Forms/Generic study). Minting
// a standalone link for a PR_REVIEW research would let a participant fill out TLX completely outside
// the AI/Report review flow it's meant to measure, which the study design doesn't allow.
function includesStandaloneTlxLink(usesTlx, taskType) {
  return !!usesTlx && taskType !== 'PR_REVIEW';
}

app.post('/api/consent/submit', async (req, res) => {
  const { participantId, lang, researchId } = req.body ?? {};
  if (!isNonEmptyString(participantId, 50)) {
    res.status(400).json({ error: 'Invalid payload: participantId' });
    return;
  }
  if (lang !== 'sr' && lang !== 'en') {
    res.status(400).json({ error: 'Invalid payload: lang' });
    return;
  }
  const parsedResearchId = parseOptionalResearchId(researchId);
  if (!parsedResearchId.ok) {
    res.status(400).json({ error: 'Invalid payload: researchId' });
    return;
  }

  try {
    const sql = getDb();

    // 2026-09-09 defense in depth — see isPortalActive's header comment.
    if (parsedResearchId.value != null && !(await isPortalActive(sql, parsedResearchId.value))) {
      res.status(403).json({ error: 'NOT_ACTIVE' });
      return;
    }

    // Item 1 of admin-dashboard-andrejkatin's "platform improvements round 2" plan — same
    // ambiguity check as GET /api/participant/:id above; this is the write side of the same
    // bare-id entry point. A researchId (from a /r/:slug visit or a resolved magic link) scopes
    // the lookup the same way lookupParticipantRows does above, making the collision
    // structurally unreachable on that path.
    const rows = await lookupConsentSubmitRows(sql, participantId, parsedResearchId.value);
    if (rows.length > 1) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!rows.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const isTestParticipant = rows[0].IsTestParticipant === true;
    const email = rows[0].Email;
    if (!email && !isTestParticipant) {
      res.status(400).json({ error: 'NO_EMAIL' });
      return;
    }
    // Language is locked forever once set for a real participant — a returning one keeps
    // whatever was chosen the first time. A test participant can freely change it on each resubmit.
    const finalLang = isTestParticipant ? lang : (rows[0].Language ?? lang);
    // Defaults to true (matches the DB column's own DEFAULT TRUE) for a participant with no
    // ResearchId on file — same "never break, fall back to the original behavior" rule as
    // getConsentFormFor's fallback above.
    const usesPsychTests = rows[0].UsesPsychTests ?? true;
    // Part D of the platform re-architecture (2026-09-07) — NASA-TLX became a third possible
    // module, independent of the REI-40/Big Five pair above. Defaults to true for a participant
    // with no ResearchId, matching the same "never break" fallback used throughout this file.
    const usesTlx = rows[0].UsesTlx ?? true;
    // See includesStandaloneTlxLink's own comment above — a PR_REVIEW research delivers TLX only
    // via the Code Review AI handoff, never a standalone magic-link.
    const includeTlxLink = includesStandaloneTlxLink(usesTlx, rows[0].TaskType);
    // Task-app link (2026-09-14) — gated on the participant's own assignment, not a research
    // toggle (see issueSurveyLinks.mjs's own comment on this).
    const genericTaskId = rows[0].GenericTaskId ?? null;
    // Demographic Questionnaire (2026-10-01) — research-level toggle, same shape as
    // usesPsychTests/usesTlx. Defaults false (unlike those two) since it's a brand-new feature a
    // participant with no ResearchId (or a research that hasn't turned it on) shouldn't suddenly
    // get.
    const usesDemographics = rows[0].UsesDemographics ?? false;
    // Same fallback chain as studyDisplayName below: an explicit override, else the research's
    // display name, else its raw Name, else sendMail's/each email builder's own hardcoded default.
    const senderName = rows[0].EmailSenderName || rows[0].StudyDisplayName || rows[0].ResearchName || undefined;

    // Scoped by the ResearchId the SELECT above already resolved (rows[0].ResearchId, not the
    // raw request param) — a real bug caught live during this feature's own verification: with a
    // researchId-scoped SELECT returning exactly one row, a still-bare UPDATE ...WHERE
    // ParticipantId=... would silently touch every OTHER research's identically-ID'd participant
    // row too (confirmed: all 3 rows in a 3-way collision test got the same ConsentGivenAt/
    // Language from a single scoped submit call, before this fix). Using the resolved row's own
    // ResearchId keeps this correct for the unscoped/bare-login path too (already-unique there).
    // A test participant's ConsentGivenAt/Language are OVERWRITTEN on every resubmit (not
    // COALESCEd) — the whole point of a repeatable test participant is being able to redo this
    // step indefinitely, not have the first-ever submission lock it forever.
    if (isTestParticipant) {
      await sql`
        UPDATE "Participant" SET "Language" = ${lang}, "ConsentGivenAt" = NOW()
        WHERE "ParticipantId" = ${participantId} AND "ResearchId" IS NOT DISTINCT FROM ${rows[0].ResearchId}
      `;
      res.json({ ok: true });
      return;
    }

    await sql`
      UPDATE "Participant"
      SET "Language" = COALESCE("Language", ${lang}),
          "ConsentGivenAt" = COALESCE("ConsentGivenAt", NOW())
      WHERE "ParticipantId" = ${participantId} AND "ResearchId" IS NOT DISTINCT FROM ${rows[0].ResearchId}
    `;

    // A research can opt out of psychological tests and/or NASA-TLX entirely (Phase D of
    // platform-ification; NASA-TLX added in Part D of the platform re-architecture) — when
    // NEITHER applies (nor a standalone TLX link, nor a task), no tokens are issued and the
    // participant gets a fixed thank-you email instead of the "here are your links" one.
    if (usesPsychTests || includeTlxLink || genericTaskId != null || usesDemographics) {
      const { rei40Url, bigfiveUrl, nasaTlxUrl, taskUrl, demographicUrl } = await issueSurveyLinks(sql, {
        participantId, usesPsychTests, usesTlx: includeTlxLink, genericTaskId, usesDemographics,
      });
      const urls = [rei40Url, bigfiveUrl, nasaTlxUrl].filter(Boolean);

      const { subject, html } = buildConsentEmail(finalLang, { urls, taskUrl, demographicUrl, senderName });
      await sendMail({ to: email, subject, html, fromName: senderName });
    } else {
      const studyDisplayName = rows[0].StudyDisplayName || rows[0].ResearchName || 'BeyondAI';
      const { subject, html } = buildThankYouEmail(finalLang, { studyDisplayName, senderName });
      await sendMail({ to: email, subject, html, fromName: senderName });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[DB] consent submit error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Part E of the platform re-architecture (2026-09-07) — the consent-OFF counterpart to
// /api/consent/submit: no consent text, no email, the participant sees their module links right
// on screen after entering their ID (LoginComponent still asks for the language pick first, same
// as the consent-ON path). Locks Language the same COALESCE-once way, but deliberately never
// touches ConsentGivenAt — this research doesn't use consent at all, so there's nothing to record.
async function lookupLinksIssueRows(sql, participantId, researchId) {
  if (researchId != null) {
    return sql`
      SELECT p."Guid", p."Language", p."ResearchId", p."GenericTaskId", COALESCE(r."UsesConsentForm", TRUE) AS "UsesConsentForm",
             r."UsesPsychTests", r."UsesTlx", r."TaskType", r."UsesDemographics"
      FROM "Participant" p
      LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
      WHERE p."ParticipantId" = ${participantId} AND p."ResearchId" = ${researchId}
    `;
  }
  return sql`
    SELECT p."Guid", p."Language", p."ResearchId", p."GenericTaskId", COALESCE(r."UsesConsentForm", TRUE) AS "UsesConsentForm",
           r."UsesPsychTests", r."UsesTlx", r."TaskType", r."UsesDemographics"
    FROM "Participant" p
    LEFT JOIN "Research" r ON r."Id" = p."ResearchId"
    WHERE p."ParticipantId" = ${participantId}
  `;
}

app.post('/api/links/issue', async (req, res) => {
  const { participantId, lang, researchId } = req.body ?? {};
  if (!isNonEmptyString(participantId, 50)) {
    res.status(400).json({ error: 'Invalid payload: participantId' });
    return;
  }
  if (lang !== 'sr' && lang !== 'en') {
    res.status(400).json({ error: 'Invalid payload: lang' });
    return;
  }
  const parsedResearchId = parseOptionalResearchId(researchId);
  if (!parsedResearchId.ok) {
    res.status(400).json({ error: 'Invalid payload: researchId' });
    return;
  }

  try {
    const sql = getDb();
    // 2026-09-09 defense in depth — see isPortalActive's header comment.
    if (parsedResearchId.value != null && !(await isPortalActive(sql, parsedResearchId.value))) {
      res.status(403).json({ error: 'NOT_ACTIVE' });
      return;
    }
    const rows = await lookupLinksIssueRows(sql, participantId, parsedResearchId.value);
    if (rows.length > 1) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!rows.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (rows[0].UsesConsentForm) {
      // Defense in depth — the frontend only ever calls this endpoint after checkParticipant
      // reported usesConsentForm: false, but a direct call against a consent-ON research would
      // otherwise skip that research's real consent step entirely.
      res.status(400).json({ error: 'CONSENT_FORM_REQUIRED' });
      return;
    }

    // Scoped by the resolved row's own ResearchId — same collision-fix reasoning as
    // consent/submit's UPDATE above (caught by the same live test).
    await sql`
      UPDATE "Participant" SET "Language" = COALESCE("Language", ${lang})
      WHERE "ParticipantId" = ${participantId} AND "ResearchId" IS NOT DISTINCT FROM ${rows[0].ResearchId}
    `;
    const finalLang = rows[0].Language ?? lang;

    const usesPsychTests = rows[0].UsesPsychTests ?? true;
    // Same PR_REVIEW-handoff exclusion as /api/consent/submit — see includesStandaloneTlxLink.
    const includeTlxLink = includesStandaloneTlxLink(rows[0].UsesTlx ?? true, rows[0].TaskType);
    const genericTaskId = rows[0].GenericTaskId ?? null;
    const usesDemographics = rows[0].UsesDemographics ?? false;
    const items = await resolveOrIssuePortalLinks(sql, {
      participantId, participantGuid: rows[0].Guid, usesPsychTests, usesTlx: includeTlxLink, genericTaskId, usesDemographics,
    });

    res.json({ ok: true, lang: finalLang, items });
  } catch (err) {
    console.error('[DB] links issue error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.listen(PORT, () => {
  console.log(`Consent API server listening on http://localhost:${PORT}`);
});
