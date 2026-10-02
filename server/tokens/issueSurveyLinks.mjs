import crypto from 'node:crypto';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (2026-10-02 follow-up, was 24h)

const REI40_APP_URL = process.env.REI40_APP_URL || 'http://localhost:4300';
const BIGFIVE_APP_URL = process.env.BIGFIVE_APP_URL || 'http://localhost:4301';
const NASA_TLX_APP_URL = process.env.NASA_TLX_APP_URL || 'http://localhost:4201';
const TASK_APP_URL = process.env.TASK_APP_URL || 'http://localhost:4304';
const DEMOGRAPHIC_APP_URL = process.env.DEMOGRAPHIC_APP_URL || 'http://localhost:4305';

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Mints (or re-mints, on repeat calls — `ON CONFLICT ... DO UPDATE`) whichever of the REI-40/
 * Big Five/NASA-TLX magic-link tokens a research's modules call for, and returns their full
 * URLs. Shared between the consent-ON email flow (`POST /api/consent/submit`) and the
 * consent-OFF portal (Part E of the platform re-architecture, 2026-09-07) — both need the exact
 * same token-minting logic, just a different final step (email vs. show-on-screen).
 *
 * `ON CONFLICT ("ParticipantGuid", "SurveyType")` — SurveyAccessToken's uniqueness moved off the
 * bare (globally non-unique, per-research-scoped) ParticipantId in item 1 of admin-dashboard's
 * "platform improvements round 2" plan; ParticipantGuid is auto-populated by a shared-DB trigger
 * from ParticipantId before the conflict check runs, so passing the bare participantId here is
 * still correct — no application-side Guid resolution needed.
 */
export async function issueSurveyLinks(sql, { participantId, usesPsychTests, usesTlx, genericTaskId, usesDemographics }) {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const links = {};

  if (usesPsychTests) {
    const rei40Token = generateToken();
    const bigfiveToken = generateToken();
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, 'REI40', ${rei40Token}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, 'BIGFIVE', ${bigfiveToken}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    links.rei40Url = `${REI40_APP_URL}/link/${rei40Token}`;
    links.bigfiveUrl = `${BIGFIVE_APP_URL}/link/${bigfiveToken}`;
  }

  if (usesTlx) {
    const tlxToken = generateToken();
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, 'NASA_TLX', ${tlxToken}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    links.nasaTlxUrl = `${NASA_TLX_APP_URL}/link/${tlxToken}`;
  }

  // Task-app link (2026-09-14) — gated on the participant actually having an assigned
  // GenericTask, not a Research-level toggle: the assignment itself is the "on" signal, same as
  // how the admin UI only ever sets Participant.GenericTaskId for a GENERIC-type research.
  if (genericTaskId != null) {
    const taskToken = generateToken();
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, 'GENERIC_TASK', ${taskToken}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    links.taskUrl = `${TASK_APP_URL}/link/${taskToken}`;
  }

  // Demographic Questionnaire (2026-10-01) — gated on the research-level UsesDemographics
  // toggle, same shape as usesPsychTests/usesTlx (a stored, researcher-set boolean read once by
  // the caller), not a per-participant signal like genericTaskId — the questionnaire is the same
  // for every participant in a research, unlike a per-participant task assignment.
  if (usesDemographics) {
    const demoToken = generateToken();
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, 'DEMOGRAPHIC', ${demoToken}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    links.demographicUrl = `${DEMOGRAPHIC_APP_URL}/link/${demoToken}`;
  }

  return links;
}

const MODULE_DEFS = [
  { type: 'REI40', urlBase: REI40_APP_URL, resultTable: 'Rei40Result' },
  { type: 'BIGFIVE', urlBase: BIGFIVE_APP_URL, resultTable: 'BigFiveResult' },
  { type: 'NASA_TLX', urlBase: NASA_TLX_APP_URL, resultTable: 'TlxResult' },
  // GenericTaskSubmission is keyed by ParticipantGuid alone (one submission ever), matching every
  // other resultTable's own completion-signal shape exactly — no special-casing needed below.
  { type: 'GENERIC_TASK', urlBase: TASK_APP_URL, resultTable: 'GenericTaskSubmission' },
  { type: 'DEMOGRAPHIC', urlBase: DEMOGRAPHIC_APP_URL, resultTable: 'DemographicResponse' },
];

/**
 * Consent-OFF portal variant (Part E of the platform re-architecture, 2026-09-07) — unlike
 * `issueSurveyLinks` above (always mints a fresh token, fine for the one-shot post-consent email),
 * this is meant to be hit on every portal visit: a completed module is reported as such instead
 * of a link (no re-issuing a token nobody needs anymore), and an incomplete module's still-valid
 * token is *reused* rather than replaced, so a link the participant already opened in another tab
 * keeps working. Only a genuinely missing/expired token gets a fresh one.
 */
export async function resolveOrIssuePortalLinks(sql, { participantId, participantGuid, usesPsychTests, usesTlx, genericTaskId, usesDemographics }) {
  const wanted = MODULE_DEFS.filter((m) => {
    if (m.type === 'NASA_TLX') return usesTlx;
    if (m.type === 'GENERIC_TASK') return genericTaskId != null;
    if (m.type === 'DEMOGRAPHIC') return usesDemographics;
    return usesPsychTests;
  });
  const items = [];

  for (const m of wanted) {
    const completed = await sql.query(
      `SELECT 1 FROM "${m.resultTable}" WHERE "ParticipantGuid" = $1 LIMIT 1`,
      [participantGuid]
    );
    if (completed.length) {
      items.push({ type: m.type, status: 'completed' });
      continue;
    }

    const existing = await sql`
      SELECT "Token", "ExpiresAt" FROM "SurveyAccessToken"
      WHERE "ParticipantGuid" = ${participantGuid} AND "SurveyType" = ${m.type} LIMIT 1
    `;
    let token;
    if (existing.length && new Date(existing[0].ExpiresAt) > new Date()) {
      token = existing[0].Token;
    } else {
      token = generateToken();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
      await sql`
        INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
        VALUES (${participantId}, ${m.type}, ${token}, ${expiresAt})
        ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
          "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
      `;
    }
    items.push({ type: m.type, status: 'link', url: `${m.urlBase}/link/${token}` });
  }

  return items;
}
