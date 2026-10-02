import { Injectable, signal } from '@angular/core';
import { ConsentSection, PortalLinkItem } from './database.service';

export interface ConsentState {
  participantId: string;
  lang: 'sr' | 'en';
  /** Phase C of platform-ification — the participant's research-resolved Consent Form content,
   *  fetched once at login and carried through to the consent page instead of a second
   *  round-trip. Optional only for backward compatibility with any already-persisted
   *  sessionStorage state from before this field existed. */
  consentSections?: ConsentSection[];
  checkboxTextSr?: string;
  checkboxTextEn?: string;
  /** Part E of the platform re-architecture (2026-09-07) — set only for a UsesConsentForm=false
   *  research; carries the resolved module links/completion status from login straight to the
   *  /links page, same "fetch once, carry through" pattern as consentSections above. */
  linkItems?: PortalLinkItem[];
  /** 2026-09-08 follow-up — carried from login through to ConsentComponent's own later
   *  submitConsent call, so it stays scoped too (a separate page navigation after /login,
   *  otherwise its own participantId lookup would revert to the unscoped/ambiguity-prone path). */
  researchId?: number | null;
}

const STORAGE_KEY = 'consent-state';

/**
 * Minimal session state: just the participant id + chosen language, set right after the login
 * step, read by the consent page. Persisted to sessionStorage so a page refresh mid-flow doesn't
 * lose the login (mirrors REI-40/Big Five's StateService).
 */
@Injectable({ providedIn: 'root' })
export class StateService {
  private readonly _state = signal<ConsentState | null>(this.restore());
  readonly state = this._state.asReadonly();

  setState(state: ConsentState): void {
    this._state.set(state);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  clear(): void {
    this._state.set(null);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  private restore(): ConsentState | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ConsentState) : null;
    } catch {
      return null;
    }
  }
}
