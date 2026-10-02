import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { StateService } from '../services/state.service';
import { DatabaseService, ParticipantCheckResult } from '../services/database.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent implements OnInit {
  private fb = inject(FormBuilder);
  private state = inject(StateService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private db = inject(DatabaseService);
  private translate = inject(TranslateService);

  readonly isChecking = signal(false);
  readonly participantNotFound = signal(false);
  readonly checkFailed = signal(false);
  /** The bare-id form is test-participants-only now — a real participant typing their id sees
   *  this instead of a generic error, telling them to use their emailed link instead. */
  readonly personalLinkRequired = signal(false);

  // 2026-09-08 follow-up — a research-scoped entry point (/r/:slug) resolves its slug into a
  // researchId before the participant-id form is even usable; the bare /login route (no slug
  // param) leaves all three of these at their initial values and behaves exactly as before.
  readonly researchSlug = signal<string | null>(null);
  readonly researchId = signal<number | null>(null);
  readonly researchName = signal<string | null>(null);
  readonly researchResolving = signal(false);
  readonly researchNotFound = signal(false);
  // 2026-09-09 — the researcher hasn't clicked "Aktiviraj" on this link yet (Consent Form →
  // Delivery page in admin-dashboard). Distinct from researchNotFound: the slug is real, it's
  // just not open to participants right now.
  readonly researchNotActive = signal(false);

  // Before a Participant ID is even entered, there's no research to resolve consentLanguages
  // from — this is just the app's own default UI chrome language (browser/localStorage), not a
  // participant-facing choice yet.
  readonly currentLang = signal(this.translate.currentLang || 'sr');

  // 2026-09-08 follow-up — "does the participant even see a language choice" now depends on the
  // resolved research's ConsentLanguageSr/En, which only exists once checkParticipant() answers.
  // Set only in the one case that actually needs a choice (no Language locked yet AND the
  // research offers both) — everything else (a returning participant, or a research offering
  // exactly one language) resolves and proceeds with zero picker shown at all, per the explicit
  // "kontroliše da li se uopšte pita za jezik" requirement.
  readonly pendingChoice = signal<{ participantId: string; result: ParticipantCheckResult } | null>(null);

  setLang(lang: string): void {
    this.translate.use(lang);
    this.currentLang.set(lang);
    try { localStorage.setItem('consent-lang', lang); } catch { /* ignore */ }
  }

  form = this.fb.group({
    participantId: ['', [Validators.required, Validators.pattern(/\S/), Validators.maxLength(50)]],
  });

  async ngOnInit(): Promise<void> {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (!slug) return;

    this.researchSlug.set(slug);
    this.researchResolving.set(true);
    const result = await this.db.resolveResearch(slug);
    this.researchResolving.set(false);
    if (!result.ok) {
      if (result.error === 'NOT_ACTIVE') {
        this.researchNotActive.set(true);
      } else {
        this.researchNotFound.set(true);
      }
      return;
    }
    this.researchId.set(result.id);
    this.researchName.set(result.name);
  }

  onParticipantIdInput(): void {
    this.participantNotFound.set(false);
    this.checkFailed.set(false);
    this.personalLinkRequired.set(false);
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.isChecking()) return;

    const participantId = this.form.value.participantId!.trim();

    this.participantNotFound.set(false);
    this.checkFailed.set(false);
    this.personalLinkRequired.set(false);
    this.isChecking.set(true);

    try {
      const result = await this.db.checkParticipant(participantId, this.researchId() ?? undefined);
      if (!result.exists) {
        this.participantNotFound.set(true);
        this.isChecking.set(false);
        return;
      }

      // Language is locked forever once set (either from a prior visit or right now) — a
      // participant who already has a Language on file keeps it regardless of anything else.
      if (result.language) {
        await this.proceed(participantId, result.language, result);
        return;
      }

      const offeredLang = !result.consentLanguages.sr ? 'en' : !result.consentLanguages.en ? 'sr' : null;
      if (offeredLang) {
        // Exactly one language offered — resolved automatically, no picker ever shown.
        await this.proceed(participantId, offeredLang, result);
        return;
      }

      // Both offered and nothing locked yet — the one case that genuinely needs a choice. Stash
      // the already-fetched result so choosing a language doesn't re-check the participant.
      this.pendingChoice.set({ participantId, result });
      this.isChecking.set(false);
    } catch (err: any) {
      if (err?.status === 403 && err?.error?.error === 'PERSONAL_LINK_REQUIRED') {
        this.personalLinkRequired.set(true);
      } else {
        this.checkFailed.set(true);
      }
      this.isChecking.set(false);
    }
  }

  async chooseLanguage(lang: 'sr' | 'en'): Promise<void> {
    const pending = this.pendingChoice();
    if (!pending || this.isChecking()) return;
    this.setLang(lang);
    this.isChecking.set(true);
    await this.proceed(pending.participantId, lang, pending.result);
  }

  private async proceed(participantId: string, lang: 'sr' | 'en', result: ParticipantCheckResult): Promise<void> {
    // Keep the app's own UI chrome in sync with the resolved content language — matters most for
    // the auto-resolved (single-offered-language) case, which never goes through chooseLanguage's
    // own setLang() call above.
    if (lang !== this.currentLang()) this.setLang(lang);

    // Prefer the already-known researchId (resolved from the /r/:slug path itself) but fall back
    // to whatever the participant lookup resolved (the bare /login path only learns it here).
    const researchId = this.researchId() ?? result.researchId ?? null;

    try {
      // Part E of the platform re-architecture (2026-09-07) — a UsesConsentForm=false research
      // skips the consent screen (and email) entirely: resolve the module links right now and
      // show them directly, gated behind nothing but the participant ID they just entered.
      if (!result.usesConsentForm) {
        const issued = await this.db.issueLinks(participantId, lang, researchId);
        if (!issued.ok) {
          this.pendingChoice.set(null);
          this.checkFailed.set(true);
          return;
        }
        this.state.setState({ participantId, lang: issued.lang, linkItems: issued.items, researchId });
        this.router.navigate(['/links']);
        return;
      }

      this.state.setState({
        participantId,
        lang,
        consentSections: result.consentSections,
        checkboxTextSr: result.checkboxTextSr,
        checkboxTextEn: result.checkboxTextEn,
        researchId,
      });

      if (result.alreadyConsented) {
        this.router.navigate(['/done']);
      } else {
        this.router.navigate(['/consent']);
      }
    } catch {
      this.pendingChoice.set(null);
      this.checkFailed.set(true);
    } finally {
      this.isChecking.set(false);
    }
  }
}
