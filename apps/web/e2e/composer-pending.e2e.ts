import { expect, test } from '@playwright/test';

import { makeMessage, makeTicket, uuid } from '../src/test/fixtures';

import { APP_ORIGIN, mockBackend } from './backend';
import { E2E_API_URL } from './constants';
import { errorBody, mockPortal, SAMPLE_VALUE } from './portal-backend';

// Hold the response explicitly: no sleeps, retries, real messages or credentials.
for (const surface of ['staff', 'gmail', 'portal'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`${surface}: pending reply freezes editing; ${outcome} unlocks the draft`, async ({
      page,
    }) => {
      const ticket = makeTicket(1, { channel: surface === 'gmail' ? 'gmail' : 'portal' });
      if (surface === 'portal') await mockPortal(page);
      else await mockBackend(page, { tickets: [ticket] });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let posts = 0;
      const path =
        surface === 'portal' ? '/v1/portal/tickets/OPS-12/replies' : '/v1/tickets/OPS-1/replies';
      await page.route(`${E2E_API_URL}${path}`, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        posts += 1;
        await pending;
        await route.fulfill({
          status: outcome === 'failure' ? 500 : 201,
          headers: {
            'access-control-allow-origin': APP_ORIGIN,
            'access-control-allow-credentials': 'true',
          },
          json:
            outcome === 'failure'
              ? errorBody(500, 'internal')
              : surface === 'portal'
                ? {
                    message: {
                      id: uuid(99),
                      from: 'customer',
                      authorName: null,
                      body: 'Preserve this draft',
                      createdAt: '2026-11-05T05:00:00.000Z',
                    },
                    status: 'in_progress',
                    statusLabel: 'In progress',
                  }
                : {
                    message: makeMessage(99, ticket, { direction: 'outbound', delivery: null }),
                    ticket,
                  },
        });
      });
      await page.goto(
        surface === 'portal' ? `/portal/tickets/OPS-12#token=${SAMPLE_VALUE}` : '/?ticket=OPS-1',
      );
      const editor = page.getByRole('textbox', {
        name: surface === 'portal' ? 'Your message' : 'Public reply',
        exact: true,
      });
      await editor.fill('Preserve this draft');
      await page.getByRole('button', { name: 'Send reply', exact: true }).click();
      await expect.poll(() => posts).toBe(1);
      if (surface === 'gmail') {
        await expect(editor).toHaveAttribute('contenteditable', 'false');
        await expect(editor).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('textbox', { name: 'To', exact: true })).toBeDisabled();
        await expect(page.getByRole('textbox', { name: 'Subject', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
      } else await expect(editor).toBeDisabled();
      if (surface !== 'portal') {
        await expect(page.getByRole('radio', { name: 'Internal note' })).toBeDisabled();
        await page.keyboard.press('n');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expect(page.getByRole('textbox', { name: 'Internal note', exact: true })).toHaveCount(
          0,
        );
      }
      release();
      if (surface === 'gmail') await expect(editor).toHaveAttribute('contenteditable', 'true');
      else await expect(editor).toBeEnabled();
      if (surface === 'gmail')
        await expect(editor).toHaveText(outcome === 'failure' ? 'Preserve this draft' : '');
      else await expect(editor).toHaveValue(outcome === 'failure' ? 'Preserve this draft' : '');
      expect(posts).toBe(1);
      if (outcome === 'failure') {
        await editor.fill('Recovered draft');
        if (surface === 'gmail') await expect(editor).toHaveText('Recovered draft');
        else await expect(editor).toHaveValue('Recovered draft');
      }
    });
  }
}
