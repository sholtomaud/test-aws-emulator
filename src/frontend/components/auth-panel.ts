import { AuthError } from '../lib/auth.ts';
import type { CognitoAuth, Session } from '../lib/auth.ts';
import { $, render } from './shared.ts';

type Mode = 'sign-in' | 'sign-up' | 'confirm';

const COPY: Record<Mode, { title: string; submit: string }> = {
  'sign-in': { title: 'Sign in', submit: 'Sign in' },
  'sign-up': { title: 'Create account', submit: 'Create account' },
  confirm: { title: 'Confirm your email', submit: 'Confirm' },
};

/**
 * Sign-in, sign-up and email confirmation. Set `auth` before use.
 * Fires `signed-in` (detail: Session) once the user is authenticated.
 */
export class AuthPanel extends HTMLElement {
  auth!: CognitoAuth;
  #mode: Mode = 'sign-in';
  #email = '';
  #password = '';

  connectedCallback(): void {
    this.#render();
  }

  #render(notice = ''): void {
    const mode = this.#mode;
    const root = render(
      this,
      /* css */ `
        .card {
          max-width: 24rem; margin: 4rem auto; padding: 1.75rem;
          background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
        }
        .switch { margin-top: 1rem; font-size: 0.875rem; text-align: center; }
        .notice { margin-bottom: 1rem; font-size: 0.875rem; }
      `,
      /* html */ `
        <form class="card" novalidate>
          <h2>${COPY[mode].title}</h2>
          <p class="notice muted" ${notice ? '' : 'hidden'}></p>
          <div role="alert" hidden></div>
          ${
            mode === 'confirm'
              ? `<div class="field">
                   <label for="code">Verification code</label>
                   <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
                 </div>`
              : `<div class="field">
                   <label for="email">Email</label>
                   <input id="email" name="email" type="email" autocomplete="username" required />
                 </div>
                 <div class="field">
                   <label for="password">Password</label>
                   <input id="password" name="password" type="password" minlength="12" required
                     autocomplete="${mode === 'sign-up' ? 'new-password' : 'current-password'}" />
                 </div>`
          }
          <button class="primary" type="submit">${COPY[mode].submit}</button>
          <p class="switch">
            ${
              mode === 'sign-in'
                ? `No account? <button class="link" type="button" data-mode="sign-up">Create one</button>`
                : mode === 'sign-up'
                  ? `Have an account? <button class="link" type="button" data-mode="sign-in">Sign in</button>`
                  : `<button class="link" type="button" data-resend>Resend code</button> ·
                     <button class="link" type="button" data-mode="sign-in">Back to sign in</button>`
            }
          </p>
        </form>
      `,
    );
    $(root, '.notice').textContent = notice;
    const email = root.querySelector<HTMLInputElement>('#email');
    if (email) email.value = this.#email;

    const form = $<HTMLFormElement>(root, 'form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void this.#submit(new FormData(form));
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.addEventListener('click', () => {
        this.#mode = button.dataset.mode as Mode;
        this.#render();
      });
    }
    root.querySelector('[data-resend]')?.addEventListener('click', () => {
      void this.#run(async () => {
        await this.auth.resendCode(this.#email);
        this.#render('A new code is on its way.');
      });
    });
  }

  async #submit(data: FormData): Promise<void> {
    const value = (name: string) => String(data.get(name) ?? '').trim();
    await this.#run(async () => {
      if (this.#mode === 'confirm') {
        await this.auth.confirmSignUp(this.#email, value('code'));
        await this.#signIn();
        return;
      }
      this.#email = value('email');
      this.#password = String(data.get('password') ?? '');
      if (this.#mode === 'sign-up') {
        const { confirmed } = await this.auth.signUp(this.#email, this.#password);
        if (!confirmed) return this.#askForCode();
      }
      await this.#signIn();
    });
  }

  async #signIn(): Promise<void> {
    if (!this.#password) {
      // Arrived at confirmation without a password in memory (e.g. reload).
      this.#mode = 'sign-in';
      return this.#render('Email confirmed. Please sign in.');
    }
    try {
      const session = await this.auth.signIn(this.#email, this.#password);
      this.#password = '';
      this.dispatchEvent(new CustomEvent<Session>('signed-in', { detail: session, bubbles: true, composed: true }));
    } catch (error) {
      if (error instanceof AuthError && error.code === 'UserNotConfirmedException') return this.#askForCode();
      throw error;
    }
  }

  #askForCode(): void {
    this.#mode = 'confirm';
    this.#render(`We sent a verification code to ${this.#email}.`);
  }

  /** Runs an action with the submit button disabled, showing any error. */
  async #run(action: () => Promise<void>): Promise<void> {
    const root = this.shadowRoot!;
    const submit = $<HTMLButtonElement>(root, 'button[type=submit]');
    submit.disabled = true;
    $(root, '[role=alert]').hidden = true;
    try {
      await action();
    } catch (error) {
      // The action may have re-rendered; look the alert up again.
      const alert = $<HTMLElement>(this.shadowRoot!, '[role=alert]');
      alert.textContent = error instanceof Error ? error.message : 'Something went wrong.';
      alert.hidden = false;
    } finally {
      const button = this.shadowRoot!.querySelector<HTMLButtonElement>('button[type=submit]');
      if (button) button.disabled = false;
    }
  }
}

customElements.define('auth-panel', AuthPanel);
