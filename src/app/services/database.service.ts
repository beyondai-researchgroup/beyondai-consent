import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

const REQUEST_TIMEOUT_MS = 10_000;

export interface ConsentSection {
  titleSr: string | null;
  titleEn: string | null;
  bodySr: string;
  bodyEn: string;
}

export interface ParticipantCheckResult {
  exists: boolean;
  alreadyConsented: boolean;
  language: 'sr' | 'en' | null;
  /** Part E of the platform re-architecture (2026-09-07) — when false, LoginComponent skips the
   *  consent screen entirely and calls issueLinks() straight away instead. Defaults true (matches
   *  every research's behavior before this toggle existed) for the exists:false case. */
  usesConsentForm: boolean;
  /** 2026-09-08 follow-up — which language(s) are even offered at first login. Both true (every
   *  research's behavior before this toggle existed, including the exists:false case) means
   *  LoginComponent's picker behaves exactly as before; exactly one true means it's skipped. */
  consentLanguages: { sr: boolean; en: boolean };
  /** Phase C of platform-ification — per-research Consent Form content, resolved server-side
   *  via the participant's Research (falls back to the original fixed text if unresolvable).
   *  Only meaningful when exists=true and usesConsentForm=true. */
  consentSections?: ConsentSection[];
  checkboxTextSr?: string;
  checkboxTextEn?: string;
  /** 2026-09-08 follow-up — present whenever the participant has a ResearchId on file, so
   *  LoginComponent can thread it into the next scoped call (submitConsent/issueLinks)
   *  regardless of which entry point (bare /login, /r/:slug, /link/:token) resolved it. */
  researchId?: number | null;
}

export type ConsentSubmitResult =
  | { ok: true }
  | { ok: false; error: 'NO_EMAIL' | 'NOT_FOUND' | 'SERVER_ERROR' };

/** 2026-09-08 follow-up — resolves a research-scoped Consent entry point's /r/:slug path segment
 *  into the researchId LoginComponent then threads through checkParticipant/submitConsent/
 *  issueLinks, scoping each of those lookups and making the AMBIGUOUS_PARTICIPANT_ID case
 *  structurally unreachable for anyone who arrives via their research's own link. */
export type ResolveResearchResult =
  | { ok: true; id: number; name: string }
  | { ok: false; error: 'NOT_FOUND' | 'NOT_ACTIVE' | 'SERVER_ERROR' };

/** Part E of the platform re-architecture — one module's resolved state on the consent-OFF
 *  portal: either a fresh/reused link to open, or an acknowledgment that it's already completed.
 *  `type` is never rendered for REI40/BIGFIVE/NASA_TLX (anti-priming — see issueSurveyLinks.mjs's
 *  own doc comment), used only for a stable list `track`; GENERIC_TASK is the one exception — a
 *  task the participant already expects isn't a psychometric instrument being disguised, so it's
 *  shown with its own plain "Zadatak" label instead of being folded into the numbered sequence
 *  (2026-09-14). */
export interface PortalLinkItem {
  type: 'REI40' | 'BIGFIVE' | 'NASA_TLX' | 'GENERIC_TASK' | 'DEMOGRAPHIC';
  status: 'link' | 'completed';
  url?: string;
}

export type IssueLinksResult =
  | { ok: true; lang: 'sr' | 'en'; items: PortalLinkItem[] }
  | { ok: false; error: 'NOT_FOUND' | 'CONSENT_FORM_REQUIRED' | 'SERVER_ERROR' };

// 2026-09-08 follow-up, Part C3 — GET /api/link/:token resolves to the same shape
// ParticipantCheckResult carries, plus the participantId itself (the frontend never asks for
// one, it's baked into the token).
export type ResolveLinkResult =
  | ({ ok: true; participantId: string } & ParticipantCheckResult)
  | { ok: false; error: 'NOT_FOUND' | 'EXPIRED' | 'NOT_ACTIVE' | 'SERVER_ERROR' };

@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private http = inject(HttpClient);

  /** researchId, when known (a /r/:slug visit already resolved it), scopes the lookup so a
   *  colliding ParticipantId in a different research can never come back ambiguous — see
   *  server.mjs's lookupParticipantRows. Omitted entirely for the bare /login path, unchanged. */
  async checkParticipant(participantId: string, researchId?: number): Promise<ParticipantCheckResult> {
    const url = `/api/participant/${encodeURIComponent(participantId)}`;
    return firstValueFrom(
      this.http
        .get<ParticipantCheckResult>(url, researchId != null ? { params: { researchId } } : {})
        .pipe(timeout(REQUEST_TIMEOUT_MS))
    );
  }

  async submitConsent(participantId: string, lang: 'sr' | 'en', researchId?: number | null): Promise<ConsentSubmitResult> {
    try {
      await firstValueFrom(
        this.http
          .post<void>('/api/consent/submit', { participantId, lang, ...(researchId != null ? { researchId } : {}) })
          .pipe(timeout(REQUEST_TIMEOUT_MS))
      );
      return { ok: true };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NO_EMAIL' || code === 'NOT_FOUND') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  async resolveResearch(slug: string): Promise<ResolveResearchResult> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ id: number; name: string }>(`/api/research/${encodeURIComponent(slug)}`).pipe(timeout(REQUEST_TIMEOUT_MS))
      );
      return { ok: true, ...res };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'NOT_ACTIVE') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  async resolveLink(token: string): Promise<ResolveLinkResult> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ participantId: string } & ParticipantCheckResult>(`/api/link/${encodeURIComponent(token)}`).pipe(timeout(REQUEST_TIMEOUT_MS))
      );
      return { ok: true, ...res };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'EXPIRED' || code === 'NOT_ACTIVE') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  async issueLinks(participantId: string, lang: 'sr' | 'en', researchId?: number | null): Promise<IssueLinksResult> {
    try {
      const res = await firstValueFrom(
        this.http
          .post<{ ok: true; lang: 'sr' | 'en'; items: PortalLinkItem[] }>('/api/links/issue', { participantId, lang, ...(researchId != null ? { researchId } : {}) })
          .pipe(timeout(REQUEST_TIMEOUT_MS))
      );
      return { ok: true, lang: res.lang, items: res.items };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'CONSENT_FORM_REQUIRED') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }
}
