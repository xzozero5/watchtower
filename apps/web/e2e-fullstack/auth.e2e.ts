import {
  Api,
  expect,
  Mailbox,
  newActor,
  ORGS,
  signInClient,
  signInStaff,
  stack,
  test,
  unique,
} from './support';

/**
 * Sign-in end to end. The magic link of a client (T-004) goes through the real emailed link: the
 * login page asks the api, the worker sends the email through SMTP to Mailpit, the test reads it
 * over Mailpit's HTTP API and opens the link. Staff use the break-glass account (no dev login).
 */
test.describe('magic link', () => {
  test('a client asks for a link, opens the emailed link and is signed in; the link works once', async ({
    browser,
  }) => {
    const mailbox = new Mailbox(`${unique('e2e-magic')}@${ORGS.acme.domain}`);
    const { context, page } = await newActor(browser);
    try {
      const link = await signInClient(page, mailbox);

      // The token was in the fragment and is gone from the address bar and the history.
      expect(page.url()).not.toContain('token');
      expect(new URL(link).hash).toMatch(/^#token=.{20,}/);

      const api = new Api(context.request);
      const session = await api.get<{
        user: { email: string; role: string; orgId: string | null };
        permissions: string[];
      }>('/v1/auth/session');
      expect(session.status).toBe(200);
      expect(session.json.user).toMatchObject({ email: mailbox.address, role: 'client' });
      expect(session.json.user.orgId).not.toBeNull();
      expect(session.json.permissions).toContain('ticket.read.org');
      expect(session.json.permissions).not.toContain('ticket.handle');

      // Signed in: the workspace shows a client's view (no internal-note mode, no staff controls).
      await expect(page.getByRole('button', { name: 'Internal note', exact: true })).toHaveCount(0);

      // The same link cannot be used again, from another browser.
      const other = await newActor(browser);
      try {
        await other.page.goto(link);
        await expect(other.page.getByText('This sign-in link cannot be used')).toBeVisible();
        const again = await new Api(other.context.request).get('/v1/auth/session');
        expect(again.status).toBe(401);
      } finally {
        await other.context.close();
      }

      // Sign out returns to the login page and ends the session on the server.
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL('**/login');
      expect((await api.get('/v1/auth/session')).status).toBe(401);
    } finally {
      await mailbox.delete();
      await context.close();
    }
  });

  test('an address with no account gets the same answer and no email', async ({ page }) => {
    const mailbox = new Mailbox(`${unique('e2e-nobody')}@nowhere-${unique('x')}.example.net`);
    await page.goto('/login');
    const customers = page.getByRole('region', { name: 'Customers' });
    await customers.getByLabel('Email address').fill(mailbox.address);
    await customers.getByRole('button', { name: 'Email me a sign-in link' }).click();
    // Same confirmation as for a real customer: nothing to enumerate.
    await expect(customers.getByText('Check your email')).toBeVisible();
    // The worker delivers a real link in well under a second here; give it a few.
    await page.waitForTimeout(4_000);
    expect(await mailbox.subjects()).toEqual([]);
  });

  test('a made-up link is refused', async ({ page }) => {
    await page.goto('/login/magic#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    await expect(page.getByText('This sign-in link cannot be used')).toBeVisible();
    await page.getByRole('link', { name: 'Back to sign-in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  });
});

test.describe('staff sign-in (break-glass)', () => {
  test('a wrong password is refused and the right one opens the queue', async ({ page }) => {
    await page.goto('/login');
    await page.getByText('Emergency administrator sign-in').click();
    const form = page.locator('details', { hasText: 'Emergency administrator sign-in' });
    await form.getByLabel('Email address').fill(stack().breakGlassEmail);
    await form.getByLabel('Password').fill(`wrong-${unique('pw')}`);
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Wrong email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await signInStaff(page);
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
    // The session works against the api as staff (role head), not as a client.
    const session = await new Api(page.context().request).get<{ user: { role: string } }>(
      '/v1/auth/session',
    );
    expect(session.json.user.role).toBe('head');
  });

  test('a signed-out request to a protected api route is refused', async ({ request }) => {
    const response = await request.get(`${stack().apiUrl}/v1/tickets`);
    expect(response.status()).toBe(401);
  });
});
