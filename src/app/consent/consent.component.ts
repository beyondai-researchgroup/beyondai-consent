import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { StateService } from '../services/state.service';
import { DatabaseService, ConsentSection } from '../services/database.service';

/** A section rendered in the participant's own locked language — resolved once here instead of
 *  picking Sr/En fields all over the template. */
interface DisplaySection {
  title: string | null;
  body: string;
}

@Component({
  selector: 'app-consent',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  templateUrl: './consent.component.html',
  styleUrl: './consent.component.scss',
})
export class ConsentComponent {
  private state = inject(StateService);
  private db = inject(DatabaseService);
  private router = inject(Router);

  readonly checked = signal(false);
  readonly isSubmitting = signal(false);
  readonly submitError = signal<'NO_EMAIL' | 'NOT_FOUND' | 'SERVER_ERROR' | null>(null);

  // Phase C of platform-ification (2026-08-18): the form's content is now per-research,
  // fetched at login and carried in StateService instead of hardcoded CONSENT.SECTION* i18n
  // text. Falls back to an empty list rather than throwing if state is somehow missing it
  // (e.g. a stale sessionStorage entry from before this field existed) — the guard in submit()
  // below already requires state() to exist at all before anything renders meaningfully.
  readonly sections = computed<DisplaySection[]>(() => {
    const s = this.state.state();
    if (!s?.consentSections) return [];
    const sr = s.lang === 'sr';
    return s.consentSections.map((section: ConsentSection) => ({
      title: (sr ? section.titleSr : section.titleEn) || null,
      body: sr ? section.bodySr : section.bodyEn,
    }));
  });

  readonly checkboxText = computed<string | null>(() => {
    const s = this.state.state();
    if (!s) return null;
    return (s.lang === 'sr' ? s.checkboxTextSr : s.checkboxTextEn) ?? null;
  });

  async submit(): Promise<void> {
    const s = this.state.state();
    if (!s || !this.checked() || this.isSubmitting()) return;

    this.isSubmitting.set(true);
    this.submitError.set(null);

    const result = await this.db.submitConsent(s.participantId, s.lang, s.researchId);
    this.isSubmitting.set(false);

    if (result.ok) {
      this.router.navigate(['/done']);
    } else {
      this.submitError.set(result.error);
    }
  }
}
