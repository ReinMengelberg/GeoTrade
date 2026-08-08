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

  <a class="brand" routerLink="/app">
    <mat-icon>public</mat-icon>
    <span>GeoTrade</span>
  </a>

  <nav class="nav">
    <a
      matButton
      routerLink="/app"
      routerLinkActive="active"
      [routerLinkActiveOptions]="{ exact: true }"
    >
      Home
    </a>

    <a
      matButton
      routerLink="/app/map"
      routerLinkActive="active"
    >
      Map
    </a>

    <a
      matButton
      routerLink="/app/settings"
      routerLinkActive="active"
    >
      Settings
    </a>
  </nav>

</mat-toolbar>

<a
  class="sign-in"
  matButton="outlined"
  routerLink="/auth/login"
>
  Sign in
</a>
    
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

.sign-in {
  position: fixed;
  top: 1rem;
  right: 1rem;
}

.toolbar {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 240px;

  display: flex;
  flex-direction: column;
  align-items: stretch;

  padding: 1rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 2rem;
}


.nav {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
