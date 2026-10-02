import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { StateService } from '../services/state.service';
import { DatabaseService } from '../services/database.service';

type LinkStatus = 'loading' | 'error';
type LinkErrorCode = 'NOT_FOUND' | 'EXPIRED' | 'NOT_ACTIVE' | 'SERVER_ERROR';

/**
 * Landing page for the emailed CONSENT_ENTRY magic-link (`/link/:token`, Part C3 of the
 * 2026-09-08 follow-up round — mints from the admin dashboard's mailing-list delivery mode).
 * Mirrors REI-40/Big Five/NASA-TLX's own `/link/:token` shape, but resolves into THIS app's
 * normal post-login flow (the exact same branching LoginComponent.submit() already does) rather
 * than a single fixed destination, since a consent-entry link can lead to /consent, /done, or
 * /links depending on the resolved research's configuration and this participant's own state.
 */
@Component({
  selector: 'app-link-access',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div class="page-centered">
      <div class="card link-card">
        @switch (status()) {
          @case ('loading') {
            <p class="link-text">{{ 'LINK.LOADING' | translate }}</p>
          }
          @case ('error') {
            <h1 class="link-title">{{ 'LINK.ERROR_TITLE' | translate }}</h1>
            @switch (errorCode()) {
              @case ('EXPIRED') {
                <p class="link-text">{{ 'LINK.ERROR_EXPIRED' | translate }}</p>
              }
              @case ('NOT_FOUND') {
                <p class="link-text">{{ 'LINK.ERROR_NOT_FOUND' | translate }}</p>
              }
              @case ('NOT_ACTIVE') {
                <p class="link-text">{{ 'LINK.ERROR_NOT_ACTIVE' | translate }}</p>
              }
              @default {
                <p class="link-text">{{ 'LINK.ERROR_SERVER' | translate }}</p>
              }
            }
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .link-card {
      max-width: 460px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .link-title {
      font-size: 22px;
      font-weight: 700;
    }
    .link-text {
      color: var(--color-muted);
      margin: 0;
      line-height: 1.6;
    }
  `],
})
export class LinkAccessComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private db = inject(DatabaseService);
  private state = inject(StateService);
  private translate = inject(TranslateService);

  readonly status = signal<LinkStatus>('loading');
  readonly errorCode = signal<LinkErrorCode | null>(null);

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.paramMap.get('token');
    if (!token) {
      this.status.set('error');
      this.errorCode.set('NOT_FOUND');
      return;
    }

    const result = await this.db.resolveLink(token);
    if (!result.ok) {
      this.status.set('error');
      this.errorCode.set(result.error);
      return;
    }

    // Same language resolution LoginComponent uses for the auto-resolved (no picker) case — a
    // mailing-list recipient's Language is normally already set by the time they click their
    // link (the admin dashboard's mailing-list endpoint resolves and stores it at send time), so
    // this mostly just reads that back; the fallback chain only matters for an edge case (a
    // future token-issuing path that doesn't pre-set Language).
    const offeredLang = !result.consentLanguages.sr ? 'en' : !result.consentLanguages.en ? 'sr' : null;
    const lang = result.language ?? offeredLang ?? (this.translate.currentLang as 'sr' | 'en') ?? 'sr';
    if (lang !== this.translate.currentLang) this.translate.use(lang);

    if (!result.usesConsentForm) {
      const issued = await this.db.issueLinks(result.participantId, lang, result.researchId);
      if (!issued.ok) {
        this.status.set('error');
        this.errorCode.set('SERVER_ERROR');
        return;
      }
      this.state.setState({ participantId: result.participantId, lang: issued.lang, linkItems: issued.items, researchId: result.researchId });
      this.router.navigate(['/links']);
      return;
    }

    this.state.setState({
      participantId: result.participantId,
      lang,
      consentSections: result.consentSections,
      checkboxTextSr: result.checkboxTextSr,
      checkboxTextEn: result.checkboxTextEn,
      researchId: result.researchId,
    });

    if (result.alreadyConsented) {
      this.router.navigate(['/done']);
    } else {
      this.router.navigate(['/consent']);
    }
  }
}
