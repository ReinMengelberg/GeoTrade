import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

@Component({
  selector: 'app-register',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <header class="header">
      <h1>Create an account</h1>
      <p>Start trading on GeoTrade.</p>
    </header>

    <form class="form" [formGroup]="form" (ngSubmit)="submit()">
      <mat-form-field>
        <mat-label>Name</mat-label>
        <input matInput type="text" formControlName="name" autocomplete="name" />
        @if (form.controls.name.hasError('required')) {
          <mat-error>Name is required.</mat-error>
        }
      </mat-form-field>

      <mat-form-field>
        <mat-label>Email</mat-label>
        <input
          matInput
          type="email"
          formControlName="email"
          autocomplete="email"
        />
        @if (form.controls.email.hasError('required')) {
          <mat-error>Email is required.</mat-error>
        } @else if (form.controls.email.hasError('email')) {
          <mat-error>Enter a valid email address.</mat-error>
        }
      </mat-form-field>

      <mat-form-field class="last-field">
        <mat-label>Password</mat-label>
        <input
          matInput
          type="password"
          formControlName="password"
          autocomplete="new-password"
        />
        @if (form.controls.password.hasError('required')) {
          <mat-error>Password is required.</mat-error>
        } @else if (form.controls.password.hasError('minlength')) {
          <mat-error>Use at least 8 characters.</mat-error>
        }
      </mat-form-field>

      <button matButton="filled" type="submit">Create account</button>
    </form>

    <p class="alt">
      Already have an account?
      <a routerLink="/auth/login">Sign in</a>
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

    .last-field {
      margin-bottom: 1rem;
    }

    .alt {
      margin: 1.5rem 0 0;
      text-align: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }

    .alt a {
      color: var(--mat-sys-primary);
    }
  `,
})
export default class Register {
  private fb = inject(FormBuilder);

  form = this.fb.nonNullable.group({
    name: ['', [Validators.required]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  submit() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    // TODO: send the new account to the auth endpoint once it exists.
  }
}
