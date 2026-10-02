import { Routes } from '@angular/router';
import { sessionGuard } from './guards/session.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () => import('./login/login.component').then(m => m.LoginComponent),
  },
  {
    // Research-scoped entry point (2026-09-08 follow-up) — same LoginComponent, but resolves the
    // :slug route param into a researchId first, then scopes every subsequent call by it. See
    // admin-dashboard-andrejkatin's server/consent-form/mailing-list.mjs portal-link route, which
    // is what actually builds/shares links to this path.
    path: 'r/:slug',
    loadComponent: () => import('./login/login.component').then(m => m.LoginComponent),
  },
  {
    // Emailed magic-link entry point (Part C3 of the 2026-09-08 follow-up round) — minted by the
    // admin dashboard's Consent Form "mailing list" delivery mode. No sessionGuard: this route
    // itself is what establishes the session, same as /login.
    path: 'link/:token',
    loadComponent: () => import('./link-access/link-access.component').then(m => m.LinkAccessComponent),
  },
  {
    path: 'consent',
    loadComponent: () => import('./consent/consent.component').then(m => m.ConsentComponent),
    canActivate: [sessionGuard],
  },
  {
    path: 'done',
    loadComponent: () => import('./done/done.component').then(m => m.DoneComponent),
  },
  {
    // Consent-OFF portal landing page (Part E of the platform re-architecture) — reached
    // straight from /login when the participant's research has UsesConsentForm=false.
    path: 'links',
    loadComponent: () => import('./module-links/module-links.component').then(m => m.ModuleLinksComponent),
    canActivate: [sessionGuard],
  },
  { path: '**', redirectTo: 'login' },
];
