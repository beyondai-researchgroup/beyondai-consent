// Builds the bilingual, branded HTML for the "thanks for participating" email — sent instead of
// buildConsentEmail's REI-40/Big Five links when the participant's research has
// Research.UsesPsychTests = FALSE (Phase D of platform-ification). Same table-based layout/visual
// identity as consentEmail.mjs, just a different, fixed message with one configurable piece:
// the study's display name (per explicit confirmation — not free-form body text).

const COPY = {
  sr: {
    subject: 'Hvala Vam na učešću',
    preheader: 'Hvala Vam na učešću u istraživanju.',
    heading: 'Hvala Vam na učešću!',
    body: (studyName) =>
      `Hvala Vam na učešću u istraživanju „${studyName}”. Istraživači će Vas kontaktirati dalje ukoliko bude potrebno.`,
    footer: 'Za sva pitanja, kontaktirajte nas na',
  },
  en: {
    subject: 'Thank you for participating',
    preheader: 'Thank you for participating in the research.',
    heading: 'Thank you for participating!',
    body: (studyName) =>
      `Thank you for participating in the "${studyName}" research. The researchers will contact you further if needed.`,
    footer: 'For any questions, contact us at',
  },
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DEFAULT_SENDER_NAME = 'BeyondAI Research Group';

/**
 * @param {'sr'|'en'} lang
 * @param {{ studyDisplayName: string, senderName?: string }} params
 * @returns {{ subject: string, html: string }}
 */
export function buildThankYouEmail(lang, { studyDisplayName, senderName }) {
  const t = COPY[lang] ?? COPY.sr;
  // studyDisplayName is researcher-supplied free text (Study Configuration page), not a fixed
  // literal like the rest of this template's copy — escape it before interpolating into HTML.
  const safeName = escapeHtml(studyDisplayName);
  const brand = escapeHtml(senderName?.trim() || DEFAULT_SENDER_NAME);
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
            <p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">${t.body(safeName)}</p>
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
