import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

@Component({
  selector: 'app-login',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
  ],
  template: `
    <header class="header">
      <h1>Sign in</h1>
      <p>Welcome back to GeoTrade.</p>
    </header>

    <form class="form" [formGroup]="form" (ngSubmit)="submit()">
      <mat-form-field>
        <mat-label>Email</mat-label>
        <input
          matInput
          type="email"
          formControlName="email"
          autocomplete="email"
        />
        @if (email.hasError('required')) {
          <mat-error>Email is required.</mat-error>
        } @else if (email.hasError('email')) {
          <mat-error>Enter a valid email address.</mat-error>
        }
      </mat-form-field>

      <mat-form-field>
        <mat-label>Password</mat-label>
        <input
          matInput
          [type]="showPassword() ? 'text' : 'password'"
          formControlName="password"
          autocomplete="current-password"
        />
        <button
          matIconButton
          matSuffix
          type="button"
          [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
          [attr.aria-pressed]="showPassword()"
          (click)="showPassword.set(!showPassword())"
        >
          <mat-icon>{{
            showPassword() ? 'visibility_off' : 'visibility'
          }}</mat-icon>
        </button>
        @if (password.hasError('required')) {
          <mat-error>Password is required.</mat-error>
        } @else if (password.hasError('minlength')) {
          <mat-error>Use at least 8 characters.</mat-error>
        }
      </mat-form-field>

      <div class="row">
        <mat-checkbox formControlName="remember">Remember me</mat-checkbox>
        <a class="link" routerLink="/auth/login">Forgot password?</a>
      </div>

      <button matButton="filled" type="submit">Sign in</button>
    </form>

    <p class="alt">
      Don't have an account?
      <a routerLink="/auth/register">Create one</a>
    </p>
  `,
  styles: `
    .header h1 {
      margin: 0 0 0.5rem;
      font: var(--mat-sys-headline-medium);
    }

    .header p {
      margin: 0 0 2rem;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }

    .form {
      display: flex;
      flex-direction: column;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .link,
    .alt a {
      color: var(--mat-sys-primary);
    }

    .alt {
      margin: 1.5rem 0 0;
      text-align: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
})
export default class Login {
  private fb = inject(FormBuilder);

  showPassword = signal(false);

  form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    remember: [false],
  });

  get email() {
    return this.form.controls.email;
  }

  get password() {
    return this.form.controls.password;
  }

  submit() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    // TODO: send credentials to the auth endpoint once it exists.
  }
}
