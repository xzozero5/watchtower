import { describe, expect, it } from 'vitest';

import { splitQuotedHtml, splitQuotedText } from './quoted';

describe('splitQuotedHtml', () => {
  it('splits a Gmail style reply from the history under it', () => {
    const html =
      '<div>Thanks, fixed.</div><div><div>On Mon, 3 Nov 2026 at 10:00, Sam &lt;sam@example.org&gt; wrote:<br></div>' +
      '<blockquote><p>It is broken</p></blockquote></div><div>-- <br>Sig</div>';
    const out = splitQuotedHtml(html);
    expect(out.visible).toBe('<div>Thanks, fixed.</div>');
    expect(out.quoted).toContain('wrote:');
    expect(out.quoted).toContain('It is broken');
    expect(out.quoted).toContain('Sig');
  });

  it('does not trim a message that is nothing but a quote, or has none', () => {
    expect(splitQuotedHtml('<blockquote>only</blockquote>').quoted).toBeNull();
    expect(splitQuotedHtml('<p>plain</p>').quoted).toBeNull();
  });
});

describe('splitQuotedText', () => {
  it('cuts at the attribution line, folded or not', () => {
    const out = splitQuotedText(
      'Done.\n\nOn Mon, 3 Nov 2026, Sam <sam@example.org>\nwrote:\n> old text',
    );
    expect(out.visible).toBe('Done.');
    expect(out.quoted).toContain('> old text');
  });

  it('cuts at the first quoted line and at a Thai attribution', () => {
    expect(splitQuotedText('ok\n> before').visible).toBe('ok');
    expect(splitQuotedText('รับทราบ\nใน 3 พ.ย. 2569 สมชาย เขียนว่า:\n> เดิม').visible).toBe(
      'รับทราบ',
    );
  });

  it('keeps everything when there is no visible part', () => {
    expect(splitQuotedText('> only quoted').quoted).toBeNull();
  });
});
