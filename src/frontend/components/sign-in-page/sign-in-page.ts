import { BaseComponent } from '../../core/base-component.ts';
import { AuthError } from '../../lib/auth.ts';
import { $ } from '../../lib/dom.ts';
import { auth, signIn } from '../../services.ts';
import style from './sign-in-page.css?raw';
import template from './sign-in-page.html?raw';

type Mode = 'sign-in' | 'sign-up' | 'confirm';

const COPY: Record<Mode, { title: string; submit: string }> = {
  'sign-in': { title: 'Sign in', submit: 'Sign in' },
  'sign-up': { title: 'Create account', submit: 'Create account' },
  confirm: { title: 'Confirm your email', submit: 'Confirm' },
};

/**
 * The signed-out page (route `/sign-in`): sign-in, sign-up and email
 * confirmation. Signing in updates the store, and the router moves on.
 */
export class SignInPage extends BaseComponent {
  static tagName = 'sign-in-page';
  #mode: Mode = 'sign-in';
  #email = '';
  #password = '';

  constructor() {
    super(template, style);
  }

  override init(): void {
    const form = $<HTMLFormElement>(this, 'form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void this.#submit(new FormData(form));
    });
    for (const button of this.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.addEventListener('click', () => this.#show(button.dataset.mode as Mode));
    }
    $(this, '[data-resend]').addEventListener('click', () => {
      void this.#run(async () => {
        await auth.resendCode(this.#email);
        this.#show('confirm', 'A new code is on its way.');
      });
    });
    this.#show('sign-in');
  }

  /** Shows one step, with empty fields (the email is kept) and an optional notice. */
  #show(mode: Mode, notice = ''): void {
    this.#mode = mode;
    $(this, 'h2').textContent = COPY[mode].title;
    $(this, 'button[type=submit]').textContent = COPY[mode].submit;
    for (const part of this.querySelectorAll<HTMLElement>('[data-step]')) {
      const current = part.dataset.step!.split(' ').includes(mode);
      part.hidden = !current;
      // A disabled fieldset keeps its fields out of validation and of the form data.
      if (part instanceof HTMLFieldSetElement) part.disabled = !current;
    }
    $<HTMLFormElement>(this, 'form').reset();
    $<HTMLInputElement>(this, '#email').value = this.#email;
    $(this, '#password').setAttribute('autocomplete', mode === 'sign-up' ? 'new-password' : 'current-password');
    const note = $(this, '.notice');
    note.textContent = notice;
    note.hidden = !notice;
    $(this, '[role=alert]').hidden = true;
  }

  async #submit(data: FormData): Promise<void> {
    const value = (name: string) => String(data.get(name) ?? '').trim();
    await this.#run(async () => {
      if (this.#mode === 'confirm') {
        await auth.confirmSignUp(this.#email, value('code'));
        await this.#signIn();
        return;
      }
      this.#email = value('email');
      this.#password = String(data.get('password') ?? '');
      if (this.#mode === 'sign-up') {
        const { confirmed } = await auth.signUp(this.#email, this.#password);
        if (!confirmed) return this.#askForCode();
      }
      await this.#signIn();
    });
  }

  async #signIn(): Promise<void> {
    if (!this.#password) {
      // Arrived at confirmation without a password in memory.
      return this.#show('sign-in', 'Email confirmed. Please sign in.');
    }
    try {
      const [email, password] = [this.#email, this.#password];
      this.#password = '';
      await signIn(email, password);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'UserNotConfirmedException') return this.#askForCode();
      throw error;
    }
  }

  #askForCode(): void {
    this.#show('confirm', `We sent a verification code to ${this.#email}.`);
  }

  /** Runs an action with the submit button disabled, showing any error. */
  async #run(action: () => Promise<void>): Promise<void> {
    const submit = $<HTMLButtonElement>(this, 'button[type=submit]');
    const alert = $(this, '[role=alert]');
    submit.disabled = true;
    alert.hidden = true;
    try {
      await action();
    } catch (error) {
      alert.textContent = error instanceof Error ? error.message : 'Something went wrong.';
      alert.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }
}

if (!customElements.get(SignInPage.tagName)) customElements.define(SignInPage.tagName, SignInPage);
