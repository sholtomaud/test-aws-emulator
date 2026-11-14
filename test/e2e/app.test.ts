// End-to-end tests: a real browser drives the deployed web components, served
// from the emulated site bucket, through Cognito, API Gateway, Lambda and
// DynamoDB in AWS Emulator.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { stackOutputs } from '../../scripts/lib/emulator.ts';
import type { StackOutputs } from '../../scripts/lib/emulator.ts';
import { startGateway } from '../../scripts/local-gateway.ts';
import type { Gateway } from '../../scripts/local-gateway.ts';
import { createUser, deleteUser, TEST_PASSWORD, uniqueEmail } from '../helpers/users.ts';

describe('Vendor Tracker in the browser', () => {
  const cognito = new CognitoIdentityProviderClient({});
  let outputs: StackOutputs;
  let gateway: Gateway;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let pageErrors: string[];

  before(async () => {
    outputs = await stackOutputs();
    gateway = await startGateway({ port: 0 });
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    await gateway?.close();
    cognito.destroy();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    page = await context.newPage();
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(gateway.url);
  });

  afterEach(async () => {
    await context.close();
    assert.deepEqual(pageErrors, [], 'the page threw uncaught errors');
  });

  // Locators pierce the components' open shadow roots.
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });
  const signIn = async (email: string, password = TEST_PASSWORD) => {
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  const addVendor = async (name: string, category: string, contactEmail: string) => {
    await page.getByLabel('Vendor name').fill(name);
    await page.getByLabel('Category').fill(category);
    await page.getByLabel('Contact email').fill(contactEmail);
    await page.getByRole('button', { name: 'Add Vendor' }).click();
  };
  /** Resolves once the dashboard is shown and the vendor list has loaded. */
  const dashboardReady = async () => {
    await heading('Vendor Tracker').waitFor();
    await page.locator('vendor-list:not([aria-busy])').waitFor();
  };
  const vendorRow = (name: string) => page.locator('vendor-list li').filter({ hasText: name });
  const vendorCount = async () => Number(await page.locator('vendor-list #count').textContent());

  it('shows sign-in, not the dashboard, to a visitor', async () => {
    await heading('Sign in').waitFor();
    assert.equal(await page.locator('vendor-form').count(), 0);
    assert.equal(await page.title(), 'Vendor Tracker');
  });

  it('rejects wrong credentials with a message', async () => {
    await signIn('nobody@example.com', 'Wrong-password-1');
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.match((await alert.textContent()) ?? '', /incorrect|not exist/i);
    assert.equal(await page.locator('vendor-form').count(), 0);
  });

  it('lets a new user sign up, confirm their email and reach the dashboard', async () => {
    const email = uniqueEmail('e2e-signup');
    try {
      await page.getByRole('button', { name: 'Create one' }).click();
      await heading('Create account').waitFor();
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password').fill(TEST_PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();

      await heading('Confirm your email').waitFor();
      await page.getByText(`We sent a verification code to ${email}.`).waitFor();

      // A wrong code is refused.
      await page.getByLabel('Verification code').fill('000000');
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: /code/i }).waitFor();

      // The emulator sends no email, so confirm as an administrator would,
      // then sign in through the UI.
      await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: outputs.UserPoolId, Username: email }));
      await page.getByRole('button', { name: 'Back to sign in' }).click();
      await signIn(email);

      await dashboardReady();
      await page.getByText(email).waitFor();
    } finally {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: outputs.UserPoolId, Username: email })).catch(() => {});
    }
  });

  describe('signed in', () => {
    let email: string;

    beforeEach(async () => {
      email = await createUser(cognito, outputs, 'e2e');
      await signIn(email);
      await dashboardReady();
    });

    afterEach(async () => {
      await deleteUser(cognito, outputs, email);
    });

    it('adds a vendor, keeps it across a reload, and deletes it', async () => {
      const name = `Acme ${email}`;
      const before = await vendorCount();

      await addVendor(name, 'SaaS', 'sales@acme.test');

      const row = vendorRow(name);
      await row.waitFor();
      assert.match((await row.textContent()) ?? '', /SaaS · sales@acme\.test/);
      assert.equal(await vendorCount(), before + 1);
      // The form is cleared for the next vendor.
      assert.equal(await page.getByLabel('Vendor name').inputValue(), '');

      // The vendor came from DynamoDB, not page state: it survives a reload,
      // and so does the session.
      await page.reload();
      await dashboardReady();
      await vendorRow(name).waitFor();

      await vendorRow(name).getByRole('button', { name: `Delete ${name}` }).click();
      await vendorRow(name).waitFor({ state: 'detached' });
      assert.equal(await vendorCount(), before);
    });

    it('does not submit an incomplete vendor', async () => {
      const before = await vendorCount();
      await page.getByLabel('Vendor name').fill('Incomplete');
      await page.getByRole('button', { name: 'Add Vendor' }).click();
      // Native form validation blocks the submit.
      assert.equal(await page.getByLabel('Category').evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
      assert.equal(await vendorCount(), before);
      assert.equal(await vendorRow('Incomplete').count(), 0);
    });

    it('renders vendor text as text, not markup', async () => {
      const name = `<img src=x onerror="document.title='pwned'"> ${email}`;
      await addVendor(name, 'Security', 'x@y.test');
      await vendorRow(email).waitFor();
      assert.equal(await page.locator('vendor-list li img').count(), 0);
      assert.equal(await page.title(), 'Vendor Tracker');
      await vendorRow(email).getByRole('button', { name: /^Delete/ }).click();
      await vendorRow(email).waitFor({ state: 'detached' });
    });

    it('signs out and requires sign-in again, even after a reload', async () => {
      await page.getByRole('button', { name: 'Sign out' }).click();
      await heading('Sign in').waitFor();
      await page.reload();
      await heading('Sign in').waitFor();
      assert.equal(await page.locator('vendor-form').count(), 0);
    });

    it('returns to sign-in when the API rejects the session', async () => {
      // Corrupt the stored credentials: IAM auth rejects the signature (403)
      // on the next request.
      await page.evaluate(() => {
        const key = 'vendor-tracker.session';
        const session = JSON.parse(sessionStorage.getItem(key)!);
        sessionStorage.setItem(
          key,
          JSON.stringify({ ...session, credentials: { ...session.credentials, secretAccessKey: 'not-the-key' } }),
        );
      });
      await page.reload();
      await heading('Sign in').waitFor();
    });
  });

  it('lays the dashboard out in two panels on wide screens and one on phones', async () => {
    const email = await createUser(cognito, outputs, 'e2e-layout');
    try {
      await signIn(email);
      await heading('Add New Vendor').waitFor();
      const boxes = async () => ({
        form: (await page.locator('vendor-form').boundingBox())!,
        list: (await page.locator('vendor-list').boundingBox())!,
      });

      await page.setViewportSize({ width: 1280, height: 800 });
      const wide = await boxes();
      assert.ok(wide.list.x > wide.form.x + wide.form.width - 1, 'panels should sit side by side');

      await page.setViewportSize({ width: 390, height: 800 });
      const narrow = await boxes();
      assert.ok(narrow.list.y > narrow.form.y + narrow.form.height - 1, 'panels should stack');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, 'the page should not scroll sideways');
    } finally {
      await deleteUser(cognito, outputs, email);
    }
  });
});
