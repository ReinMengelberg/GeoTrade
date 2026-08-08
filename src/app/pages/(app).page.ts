import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';

@Component({
  selector: 'app-app-layout',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
  ],
  template: `
    <mat-toolbar class="toolbar">
      <a class="brand" routerLink="/">
        <mat-icon>public</mat-icon>
        <span>GeoTrade</span>
      </a>

      <nav class="nav">
        <a
          matButton
          routerLink="/"
          routerLinkActive="active"
          [routerLinkActiveOptions]="{ exact: true }"
          >Home</a
        >
      </nav>

      <span class="spacer"></span>

      <a matButton="outlined" routerLink="/auth/login">Sign in</a>
    </mat-toolbar>

    <main class="content">
      <router-outlet />
    </main>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      gap: 1rem;
      background: var(--mat-sys-surface-container);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      color: inherit;
      text-decoration: none;
      font: var(--mat-sys-title-medium);
    }

    .nav {
      display: flex;
      gap: 0.25rem;
    }

    .nav .active {
      background: var(--mat-sys-secondary-container);
    }

    .spacer {
      flex: 1 1 auto;
    }

    .content {
      flex: 1 1 auto;
    }
  `,
})
export default class AppLayout {}
