import { describe, expect, it } from 'vitest';

import { markInlineImages, prepareEmailReply } from './email-reply.js';

describe('prepareEmailReply', () => {
  it('strips active content and remote images from the composed HTML', () => {
    const out = prepareEmailReply({
      body: 'Hi',
      email: {
        cc: [],
        inline: [],
        bcc: [],
        bodyHtml:
          '<p onclick="x()">Hi <b>there</b></p><script>alert(1)</script><img src="https://t.example/p.gif"><img src="cid:a@wt"><a href="javascript:alert(1)">x</a>',
      },
    });
    const html = out.email?.bodyHtml ?? '';
    expect(html).toContain('<b>there</b>');
    expect(html).toContain('cid:a@wt');
    expect(html).not.toMatch(/script|onclick|t\.example|javascript:/i);
  });

  it('derives the text alternative when only HTML was sent', () => {
    const out = prepareEmailReply({
      body: ' ',
      email: { cc: [], bcc: [], inline: [], bodyHtml: '<p>One</p><p>Two</p>' },
    });
    expect(out.body).toContain('One');
    expect(out.body).toContain('Two');
  });

  it('sends the AI draft text as the HTML when a draft is approved, whatever HTML was posted', () => {
    const out = prepareEmailReply({
      body: 'Hello <team>\n\nIt is fixed.',
      aiDraftId: '00000000-0000-4000-8000-000000000001',
      email: { cc: [], bcc: [], inline: [], bodyHtml: '<p>Something else entirely</p>' },
    });
    expect(out.email?.bodyHtml).toBe('<p>Hello &lt;team&gt;</p><p>It is fixed.</p>');
  });

  it('leaves a reply without the email part alone', () => {
    const reply = { body: 'plain' };
    expect(prepareEmailReply(reply)).toBe(reply);
  });
});

describe('markInlineImages', () => {
  it('marks only the uploads the HTML shows inline, keeping the rest as attachments', () => {
    const records = [
      { filename: 'a.png', disposition: 'attachment', contentId: null },
      { filename: 'b.pdf', disposition: 'attachment', contentId: null },
    ];
    const out = markInlineImages(
      records,
      ['id-a', 'id-b'],
      [{ attachmentId: 'id-a', contentId: 'img1@wt.local' }],
    );
    expect(out[0]).toMatchObject({ disposition: 'inline', contentId: 'img1@wt.local' });
    expect(out[1]).toEqual(records[1]);
  });
});
