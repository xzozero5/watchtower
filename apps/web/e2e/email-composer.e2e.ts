import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DRAFT_ID, makeInsight } from '../src/test/ai-fixtures';
import { makeMessage, makeScheduledReply, makeTicket } from '../src/test/fixtures';

import { type BackendOptions, type RecordedRequest, mockBackend } from './backend';

// The email composer, the Gmail-style thread and the upload component, against the in-browser api
// stand-in (T-171). Invented names and example domains only (N1).

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TRACKER = 'https://tracker.example.net';
const ticket = makeTicket(1, { subject: 'Printer is down', channel: 'gmail' });

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const customerMail = makeMessage(1, ticket, {
  channel: 'gmail',
  bodyText: 'The printer is down. Logo below.',
  bodyHtml:
    '<p style="color:#b45309;font-weight:bold">The printer is down.</p>' +
    `<table bgcolor="#eeeeee" width="300"><tr><td style="padding:8px">Logo below.</td></tr></table>` +
    `<img data-remote-src="${TRACKER}/logo.png" alt="logo" width="40" height="40">`,
  emailMeta: {
    from: { address: 'sam@example.org', name: 'Sam Customer' },
    to: [{ address: 'help@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Printer is down',
  },
  createdAt: '2026-11-02T03:00:00.000Z',
});

async function open(page: Page, options: BackendOptions = {}) {
  const backend = await mockBackend(page, {
    tickets: [ticket],
    timelines: { 'OPS-1': [customerMail] },
    ...options,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?ticket=OPS-1');
  await expect(page.locator('[data-hydrated="true"]')).toBeAttached();
  return backend;
}

const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Public reply' });
const replies = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'POST' && r.path === '/v1/tickets/OPS-1/replies');

function sentReply() {
  return { status: 201, json: { message: makeScheduledReply(60, ticket, 5000), ticket } };
}

test.describe('the mail as the customer wrote it', () => {
  test('shows the sender formatting and holds a remote image until Display images', async ({
    page,
  }) => {
    let trackerHits = 0;
    await page.route(`${TRACKER}/**`, async (route) => {
      trackerHits += 1;
      await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });
    await open(page);

    const frame = page.frameLocator('iframe[title^="Email from Sam Customer"]');
    // The formatting arrives (colour, bold, cell padding), the way Gmail draws it.
    const paragraph = frame.locator('p', { hasText: 'The printer is down.' });
    await expect(paragraph).toHaveCSS('color', 'rgb(180, 83, 9)');
    await expect(paragraph).toHaveCSS('font-weight', '700');
    await expect(frame.locator('td')).toHaveCSS('padding-top', '8px');

    // The remote picture is held back: no request left the browser, and the reader is told.
    await expect(page.getByText(/remote images are hidden/)).toBeVisible();
    await expect(frame.locator('img[data-blocked]')).toHaveCount(1);
    expect(trackerHits).toBe(0);

    await page.getByRole('button', { name: 'Display images' }).click();
    const picture = frame.locator('img[src^="https://tracker.example.net/"]');
    await expect(picture).toHaveCount(1);
    await expect(picture).toHaveAttribute('referrerpolicy', 'no-referrer');
    // Whether the browser then fetches it depends on the page's CSP (`img-src`), which today allows no
    // remote host: that is an owner decision (T-171 report), so only the markup is asserted here.
    await expect(page.getByText(/remote images are hidden/)).toBeHidden();
  });
});

test.describe('writing the reply', () => {
  test('asks before sending outside the customer, then sends with Bcc and a confirmation', async ({
    page,
  }) => {
    let attempts = 0;
    const backend = await open(page, {
      routes: {
        'POST /v1/tickets/OPS-1/replies': () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: 409,
                json: {
                  statusCode: 409,
                  error: 'Conflict',
                  code: 'external_recipients',
                  message: 'external_recipients',
                  domains: ['stranger.test'],
                },
              }
            : sentReply();
        },
      },
    });
    await expect(page.getByTestId('email-composer')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove sam@example.org' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Bcc' }).click();
    const bcc = page.getByLabel('Bcc', { exact: true });
    await bcc.fill('someone@stranger.test');
    await bcc.press('Enter');
    await expect(page.getByRole('button', { name: 'Remove someone@stranger.test' })).toBeVisible();

    await editorOf(page).fill('We are on it.');
    await page.getByRole('button', { name: 'Send reply' }).click();

    const dialog = page.getByRole('dialog', { name: 'Send outside this customer?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('stranger.test');
    expect(replies(backend.requests)).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Send anyway' }).click();

    await expect.poll(() => replies(backend.requests).length).toBe(2);
    const body = replies(backend.requests)[1]?.body as {
      email: { bcc: { address: string }[]; confirmExternalRecipients?: boolean };
    };
    expect(body.email.confirmExternalRecipients).toBe(true);
    expect(body.email.bcc.map((a) => a.address)).toEqual(['someone@stranger.test']);
    await expect(dialog).toBeHidden();
  });

  test('edits an AI draft in the rich editor and sends it as an edit of that draft', async ({
    page,
  }) => {
    const backend = await open(page, {
      ai: { 'OPS-1': makeInsight() },
      routes: { 'POST /v1/tickets/OPS-1/replies': () => sentReply() },
    });
    const draft = page.getByTestId('ai-draft');
    await expect(draft).toBeVisible();
    await draft.getByRole('button', { name: /^Edit/ }).click();

    const editor = editorOf(page);
    await expect(editor).toContainText('Hello Riley, your account was locked');
    await expect(page.getByTestId('ai-draft-note')).toBeVisible();
    // The toolbar of the email editor is there; the person formats a word and adds a line.
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    await editor.press('End');
    await page.keyboard.type(' Thanks for your patience.');

    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect.poll(() => replies(backend.requests).length).toBe(1);
    const body = replies(backend.requests)[0]?.body as {
      editedFromDraftId?: string;
      aiDraftId?: string;
      body: string;
      email: { bodyHtml: string };
    };
    expect(body.editedFromDraftId).toBe(DRAFT_ID);
    expect(body.aiDraftId).toBeUndefined();
    expect(body.body).toContain('Thanks for your patience.');
    expect(body.email.bodyHtml).toContain('Thanks for your patience.');
  });

  test('has no accessibility violations with the composer open', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('email-composer')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude('iframe').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`)).toEqual([]);
  });
});

test.describe('uploads in the email', () => {
  test('sends a picture inline and a file as an attachment', async ({ page }) => {
    let uploads = 0;
    const backend = await open(page, {
      routes: {
        'POST /v1/uploads': () => {
          uploads += 1;
          const id = `a0000000-0000-4000-8000-00000000000${String(uploads)}`;
          return {
            status: 201,
            json: {
              id,
              filename: uploads === 1 ? 'shot.png' : 'notes.txt',
              contentType: uploads === 1 ? 'image/png' : 'text/plain',
              size: 68,
            },
          };
        },
        'POST /v1/tickets/OPS-1/replies': () => sentReply(),
      },
    });
    await expect(page.getByTestId('email-composer')).toBeVisible();

    // A picture through the editor's own button lands in the text, not in the file list.
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Insert image' }).click();
    await (await chooser).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
    await expect(editorOf(page).locator('img[data-wt-upload]')).toHaveCount(1);

    // A file through the attach button is listed, and goes as an attachment.
    await page.getByLabel('Attachments', { exact: true }).setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('line one\n'),
    });
    await expect(page.getByRole('list', { name: 'Files to attach' })).toContainText('notes.txt');
    await expect.poll(() => uploads).toBe(2);
    await expect(page.getByRole('list', { name: 'Files to attach' })).not.toContainText(
      'Could not upload',
    );

    await editorOf(page).pressSequentially('See attached.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect.poll(() => replies(backend.requests).length).toBe(1);

    const body = replies(backend.requests)[0]?.body as {
      attachmentIds: string[];
      email: { inline: { attachmentId: string; contentId: string }[]; bodyHtml: string };
    };
    expect(uploads).toBe(2);
    expect(body.email.inline).toHaveLength(1);
    expect(body.email.inline[0]?.attachmentId).toBe('a0000000-0000-4000-8000-000000000001');
    expect(body.email.bodyHtml).toContain(`cid:${body.email.inline[0]?.contentId ?? ''}`);
    // The picture is inline; the file is listed with it so the server can find both.
    expect(body.attachmentIds).toContain('a0000000-0000-4000-8000-000000000002');
  });

  test('says so when the server refuses a file, and keeps the rest of the mail', async ({
    page,
  }) => {
    await open(page, {
      routes: {
        'POST /v1/uploads': () => ({
          status: 400,
          json: {
            statusCode: 400,
            error: 'Bad Request',
            code: 'attachment_rejected',
            message: 'attachment_rejected',
          },
        }),
      },
    });
    await editorOf(page).fill('Keep this text.');
    await page
      .getByLabel('Attachments', { exact: true })
      .setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('alert').first()).toContainText('did not accept');
    await expect(editorOf(page)).toContainText('Keep this text.');
  });
});
