// Builds the bilingual, branded HTML for the "thanks for consenting, here are your links" email.
// Table-based layout for broad email-client compatibility (no external CSS/JS).

// Deliberately never names the actual instruments (REI-40 / Big Five / NASA-TLX) anywhere in
// this copy — a participant who knows which specific questionnaires are coming could look them
// up in advance and prepare/skew their answers. They're referred to only as generic numbered
// "questionnaires" until the participant is actually on the test page itself. The number of
// links varies per research (Part D of the platform re-architecture, 2026-09-07 — NASA-TLX
// became a third possible link, on top of the always-either-both-or-neither REI-40/Big Five
// pair), so `intro` stays generic rather than hardcoding "two". The Demographic Questionnaire
// (2026-10-01) is explicitly labeled rather than numbered, same reasoning as `taskLabel` below —
// it isn't a disguised psychometric instrument a participant could skew by advance knowledge.
const COPY = {
  sr: {
    subject: 'Hvala na pristanku - nastavite sa testovima',
    preheader: 'Vaši lični linkovi za testove, važe 24h.',
    heading: 'Hvala Vam na pristanku za učešće!',
    intro:
      'Cenimo Vaše učešće u istraživanju. Sledeći korak je da popunite kratke upitnike ispod. Molimo Vas da popunite sve, redosled nije bitan.',
    questionnaireLabel: (n) => `Upitnik ${n}`,
    taskLabel: 'Zadatak',
    demographicLabel: 'Demografski upitnik',
    buttonText: 'Otvori test',
    expiry:
      'Napomena: linkovi važe 7 dana od trenutka slanja ovog mejla. Ako isteknu pre nego što ih popunite, javite se istraživaču kako bi Vam poslao nove.',
    footer: 'Za sva pitanja, kontaktirajte nas na',
  },
  en: {
    subject: 'Thank you for your consent - continue with the tests',
    preheader: 'Your personal links to the questionnaires, valid for 24h.',
    heading: 'Thank you for giving your consent!',
    intro:
      "We appreciate your participation in the research. The next step is to complete the short questionnaires below. Please complete all of them; the order doesn't matter.",
    questionnaireLabel: (n) => `Questionnaire ${n}`,
    taskLabel: 'Task',
    demographicLabel: 'Demographic questionnaire',
    buttonText: 'Open test',
    expiry:
      "Note: these links are valid for 7 days from when this email was sent. If they expire before you complete them, contact the researcher for new ones.",
    footer: 'For any questions, contact us at',
  },
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DEFAULT_SENDER_NAME = 'BeyondAI Research Group';

/**
 * @param {'sr'|'en'} lang
 * @param {{ urls: string[], taskUrl?: string, demographicUrl?: string, senderName?: string }} args
 *   `urls` in the order they should be numbered/labeled — the caller decides which modules apply
 *   and in what order (typically REI-40, then Big Five, then NASA-TLX, whichever are actually
 *   enabled for the research). `taskUrl` (2026-09-14) and `demographicUrl` (2026-10-01) are each
 *   rendered as their own explicitly-labeled card ("Zadatak"/"Task", "Demografski upitnik"/
 *   "Demographic questionnaire"), kept outside the numbered sequence — neither is a disguised
 *   psychometric instrument, so no anti-priming numbering applies to either.
 * @returns {{ subject: string, html: string }}
 */
export function buildConsentEmail(lang, { urls, taskUrl, demographicUrl, senderName }) {
  const t = COPY[lang] ?? COPY.sr;
  // senderName is researcher-supplied free text (Study Configuration's EmailSenderName override,
  // or StudyDisplayName/Name as fallbacks) — escape before interpolating into HTML, same
  // discipline thankYouEmail.mjs already applies to its own studyDisplayName interpolation.
  const brand = escapeHtml(senderName?.trim() || DEFAULT_SENDER_NAME);
  const card = (label, url) => `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
              <tr>
                <td style="padding:16px;background:#eaf2ec;border-radius:8px;">
                  <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#1a2e1a;">${label}</p>
                  <a href="${url}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">${t.buttonText}</a>
                </td>
              </tr>
            </table>`;
  const linkCards = urls.map((url, i) => card(t.questionnaireLabel(i + 1), url)).join('')
    + (taskUrl ? card(t.taskLabel, taskUrl) : '')
    + (demographicUrl ? card(t.demographicLabel, demographicUrl) : '');
  const html = `
<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:0;background:#f2f7f4;font-family:'Segoe UI',Arial,sans-serif;">
  <span style="display:none;font-size:1px;color:#f2f7f4;">${t.preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f7f4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #c0dbc9;">
        <tr>
          <td style="background:#1a3a28;padding:24px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em;">${brand}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 16px;font-size:22px;color:#1a2e1a;">${t.heading}</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">${t.intro}</p>

            ${linkCards}

            <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">${t.expiry}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#6b7280;">${t.footer} <a href="mailto:beyondai.researchgroup@gmail.com" style="color:#16a34a;">beyondai.researchgroup@gmail.com</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  return { subject: t.subject, html };
}
