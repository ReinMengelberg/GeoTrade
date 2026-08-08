import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-auth-layout',
  imports: [RouterOutlet, RouterLink, MatIconModule],
  template: `
    <section class="brand-pane">
      <a class="brand" routerLink="/">
        <mat-icon>public</mat-icon>
        <span>GeoTrade</span>
      </a>

      <div class="pitch">
        <h2>Trade across borders.</h2>
        <p>
          Track markets, manage positions, and settle trades from a single
          place.
        </p>
      </div>
    </section>

    <section class="form-pane">
      <div class="form-slot">
        <router-outlet />
      </div>
    </section>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: 1fr 1fr;
      min-height: 100vh;
    }

    .brand-pane {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 3rem;
      padding: 3rem;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      align-self: flex-start;
      color: inherit;
      text-decoration: none;
      font: var(--mat-sys-title-medium);
    }

    .pitch h2 {
      margin: 0 0 0.75rem;
      font: var(--mat-sys-display-small);
    }

    .pitch p {
      margin: 0;
      max-width: 32ch;
      font: var(--mat-sys-body-large);
    }

    .form-pane {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3rem 1.5rem;
      background: var(--mat-sys-surface);
    }

    .form-slot {
      width: 100%;
      max-width: 22rem;
    }

    @media (max-width: 900px) {
      :host {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }

      .brand-pane {
        padding: 1.5rem;
      }

      .pitch {
        display: none;
      }
    }
  `,
})
export default class AuthLayout {}
