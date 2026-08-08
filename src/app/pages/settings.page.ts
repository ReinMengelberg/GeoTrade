import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';


@Component({
imports: [MatButtonModule],
  template: `
    <div class="settings">
      <h1>User Settings</h1>

      <form>
        <label>
          Username
          <input type="text" name="username" placeholder="Username" />
        </label>

        <label>
          Email
          <input type="email" name="email" placeholder="Email" />
        </label>

        <label>
          Language
          <select name="language">
            <option>English</option>
            <option>Dutch</option>
            <option>Spanish</option>
          </select>
        </label>

        <button matButton="outlined" type="submit">
          Save changes
        </button>
      </form>
    </div>
  `,

  styles: `
    :host {
      display: block;
      padding: 2rem;
    }

    .settings {
      max-width: 500px;
    }

    h1 {
      margin-bottom: 2rem;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    input,
    select {
      padding: 0.6rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      font: inherit;
    }

    button {
      align-self: flex-start;
      margin-top: 0.5rem;
    }
  `,
})
export default class SettingsPage {}