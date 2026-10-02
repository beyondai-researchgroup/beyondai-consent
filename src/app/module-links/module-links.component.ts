import { Component, computed, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { StateService } from '../services/state.service';

/** One item as actually rendered. Questionnaire items get index-based numbering (never their own
 *  `type` — anti-priming, same as the emailed links); GENERIC_TASK and DEMOGRAPHIC items are the
 *  exceptions — shown as their own plain "Zadatak"/"Demografski upitnik" cards instead, since
 *  neither is a disguised psychometric instrument a participant could skew by advance knowledge. */
interface DisplayItem {
  kind: 'questionnaire' | 'task' | 'demographic';
  number: number;
  status: 'link' | 'completed';
  url?: string;
}

/**
 * The consent-OFF portal's landing page (Part E of the platform re-architecture, 2026-09-07) —
 * shown straight after LoginComponent resolves the participant's module links, no consent text,
 * no email involved. Mirrors rei40-andrejkatin's LinkAccessComponent visual shape (a centered
 * card) but lists every module inline instead of auto-redirecting to just one.
 */
@Component({
  selector: 'app-module-links',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <div class="page-centered">
      <div class="card links-card">
        <h1 class="links-title">{{ 'LINKS.TITLE' | translate }}</h1>
        <p class="links-text">{{ 'LINKS.INTRO' | translate }}</p>

        @for (item of items(); track $index) {
          <div class="link-row">
            <span class="link-label">
              @switch (item.kind) {
                @case ('task') { {{ 'LINKS.TASK_LABEL' | translate }} }
                @case ('demographic') { {{ 'LINKS.DEMOGRAPHIC_LABEL' | translate }} }
                @default { {{ 'LINKS.ITEM_LABEL' | translate: { n: item.number } }} }
              }
            </span>
            @if (item.status === 'completed') {
              <span class="link-done">✓ {{ 'LINKS.COMPLETED' | translate }}</span>
            } @else {
              <a class="link-open" [href]="item.url" target="_blank" rel="noopener">{{ 'LINKS.OPEN' | translate }}</a>
            }
          </div>
        }

        @if (!items().length) {
          <p class="links-text">{{ 'LINKS.NONE' | translate }}</p>
        }
      </div>
    </div>
  `,
  styles: [`
    .links-card {
      max-width: 460px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .links-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
      text-align: center;
    }
    .links-text {
      color: var(--color-muted);
      margin: 0;
      line-height: 1.6;
      text-align: center;
    }
    .link-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      background: rgba(var(--color-accent-rgb), 0.08);
      border-radius: 10px;
    }
    .link-label {
      font-weight: 600;
    }
    .link-open {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      border-radius: 8px;
      background: var(--color-accent);
      color: #06231a;
      font-weight: 700;
      text-decoration: none;
      font-size: 13px;
    }
    .link-done {
      color: var(--color-accent);
      font-weight: 600;
      font-size: 13px;
    }
  `],
})
export class ModuleLinksComponent {
  private state = inject(StateService);

  readonly items = computed<DisplayItem[]>(() => {
    const linkItems = this.state.state()?.linkItems ?? [];
    // Only the plain "questionnaire" items get sequential numbering — GENERIC_TASK/DEMOGRAPHIC
    // items are excluded from that sequence entirely so adding/removing either never renumbers
    // "Upitnik 1/2".
    let n = 0;
    return linkItems.map((it) => {
      const kind: DisplayItem['kind'] = it.type === 'GENERIC_TASK' ? 'task' : it.type === 'DEMOGRAPHIC' ? 'demographic' : 'questionnaire';
      if (kind === 'questionnaire') n += 1;
      return { kind, number: n, status: it.status, url: it.url };
    });
  });
}
