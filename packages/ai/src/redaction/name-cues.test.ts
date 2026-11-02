import { describe, expect, it } from 'vitest';

import {
  detectNameCues,
  MAX_CUE_MATCHES,
  MAX_CUE_TOKENS,
  MAX_LATIN_TOKEN,
  MAX_THAI_TOKEN,
  NameMatchLimitError,
} from './detectors.js';
import { buildView } from './normalize.js';
import { createRedactor } from './redactor.js';

// QA-30 (ADR-008, 2026-11-02): a name that is not in the dictionary but follows a cue is redacted.
// No dictionary here: everything below is found by the cues alone.
const redactor = createRedactor();
const redact = (text: string): string => redactor.session({ scope: 'ticket:cues' }).redact(text);

describe('name cues, English', () => {
  it.each([
    ['my name is Somchai Jaidee and I need help', 'my name is [NAME_1] [NAME_2] and I need help'],
    ["My name's Somchai", "My name's [NAME_1]"],
    ['MY NAME IS SOMCHAI JAIDEE', 'MY NAME IS [NAME_1] [NAME_2]'],
    [
      'This is Somchai Jaidee from the finance team',
      'This is [NAME_1] [NAME_2] from the finance team',
    ],
    ['Mr Somchai called', 'Mr [NAME_1] called'],
    ['Mr. Somchai Jaidee called', 'Mr. [NAME_1] [NAME_2] called'],
    ['Mrs Anne-Marie O’Brien wrote', 'Mrs [NAME_1] [NAME_2] wrote'],
    ['Ms Somchai wrote', 'Ms [NAME_1] wrote'],
    ['Dear Somchai Jaidee,', 'Dear [NAME_1] [NAME_2],'],
    ['Dear Mr Somchai,', 'Dear Mr [NAME_1],'],
  ])('%s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each(['Regards', 'Best regards', 'Kind regards', 'Thanks', 'Thank you', 'Sincerely'])(
    'a signature after "%s,"',
    (closing) => {
      expect(redact(`Please check.\n${closing},\nSomchai Jaidee\nAcme`)).toBe(
        `Please check.\n${closing},\n[NAME_1] [NAME_2]\nAcme`,
      );
      expect(redact(`${closing},\r\n\r\nSomchai`)).toBe(`${closing},\r\n\r\n[NAME_1]`);
      expect(redact(`${closing}, Somchai`)).toBe(`${closing}, [NAME_1]`);
    },
  );

  it('gives the same word the same placeholder', () => {
    expect(redact('My name is Somchai. Thanks,\nSomchai')).toBe(
      'My name is [NAME_1]. Thanks,\n[NAME_1]',
    );
  });

  it('keeps provenance: a cue name is a ticket token, restored for the customer', () => {
    const session = redactor.session({ scope: 'ticket:prov' });
    const redacted = session.redact('my name is Somchai Jaidee');
    expect(session.snapshot().tokens['[NAME_1]']).toEqual({ value: 'Somchai', origin: 'ticket' });
    expect(session.restore(redacted, 'customer')).toEqual({
      text: 'my name is Somchai Jaidee',
      needsReview: false,
      unresolved: [],
    });
    const tool = redactor.session({ scope: 'ticket:tool' });
    tool.redactToolOutput('kb_search', 'This is Somchai');
    expect(tool.snapshot().tokens['[NAME_1]']).toEqual({
      value: 'Somchai',
      origin: 'tool',
      source: 'kb_search',
    });
  });

  it('shares the placeholder with the dictionary', () => {
    const session = createRedactor({ names: () => ['Somchai Jaidee'] }).session({ scope: 'x' });
    expect(session.redact('Somchai Jaidee wrote. Regards,\nSomchai')).toBe(
      '[NAME_1] wrote. Regards,\n[NAME_2]',
    );
  });
});

describe('name cues, Thai', () => {
  it.each([
    ['ผมชื่อสมชาย ใจดี ครับ', 'ผมชื่อ[NAME_1] [NAME_2] ครับ'],
    ['ดิฉันชื่อสมหญิง ค่ะ', 'ดิฉันชื่อ[NAME_1] ค่ะ'],
    ['ชื่อ: สมชาย', 'ชื่อ: [NAME_1]'],
    ['ชื่อ คือ สมชาย ใจดี', 'ชื่อ คือ [NAME_1] [NAME_2]'],
    ['สวัสดีคุณสมชายครับ', 'สวัสดีคุณ[NAME_1]ครับ'],
    ['คุณ สมชาย โทรมา', 'คุณ [NAME_1] โทรมา'],
    ['นายสมชายใจดี เป็นผู้แจ้ง', 'นาย[NAME_1] เป็นผู้แจ้ง'],
    ['นางสมหญิง แจ้งว่า', 'นาง[NAME_1] แจ้งว่า'],
    ['นางสาวสมหญิง ใจงาม ติดต่อมา', 'นางสาว[NAME_1] [NAME_2] ติดต่อมา'],
    ['คุณสมชายแจ้งว่าระบบล่ม', 'คุณ[NAME_1]แจ้งว่าระบบล่ม'],
    ['my name is สมชาย', 'my name is [NAME_1]'],
    ['คุณ Somchai Jaidee', 'คุณ [NAME_1] [NAME_2]'],
  ])('%s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
});

describe('false-positive guards', () => {
  it.each([
    'this is a bug in the export',
    'This is not working',
    'This is Important',
    'THIS IS URGENT',
    'Dear team, the export fails',
    'Dear Team,',
    'Dear Support Team',
    'Dear Sir or Madam',
    'Mr.',
    'Mr. and the rest',
    'ping took 200 ms Latency was high',
    'Thanks for the quick reply',
    'Thanks, I will check',
    'Regards,\nthe finance team',
    'คุณภาพของระบบแย่มาก',
    'คุณสมบัติของลูกค้า',
    'ขอบคุณครับ',
    'ขอบคุณมากค่ะ',
    'นายจ้างของลูกค้า',
    'นายหน้าขายประกัน',
    'ชื่อเสียงของบริษัท',
    'ชื่อผู้ใช้ไม่ถูกต้อง',
    'ชื่อบริษัทผิด',
    'สวัสดีครับ มีปัญหาเรื่องการเข้าสู่ระบบ',
  ])('leaves "%s" alone', (input) => {
    expect(redact(input)).toBe(input);
  });

  it('stops a Latin name at a lower-case word and at a line break', () => {
    expect(redact('my name is Somchai and I work at Acme')).toBe(
      'my name is [NAME_1] and I work at Acme',
    );
    expect(redact('Dear Somchai\nJaidee is not a name here')).toBe(
      'Dear [NAME_1]\nJaidee is not a name here',
    );
  });
});

describe('known gap (ADR-008, T-153): a name with no cue and not in the dictionary', () => {
  it('is still not found; closing this gap (NER) is a deliberate change', () => {
    expect(redact('Hi Somchai Jaidee, the export fails')).toBe(
      'Hi Somchai Jaidee, the export fails',
    );
    expect(redact('I am Somchai')).toBe('I am Somchai');
  });
});

describe('bounds (SR106-N2)', () => {
  it('reads at most three tokens', () => {
    expect(MAX_CUE_TOKENS).toBe(3);
    expect(redact('my name is Anna Maria Lopez Garcia')).toBe(
      'my name is [NAME_1] [NAME_2] [NAME_3] Garcia',
    );
  });

  it('caps the length of a token', () => {
    const long = `A${'b'.repeat(200)}`;
    const view = buildView(`my name is ${long}`);
    const [only] = detectNameCues(view);
    expect(only).toBeDefined();
    expect((only?.end ?? 0) - (only?.start ?? 0)).toBe(MAX_LATIN_TOKEN);
    const thai = 'ก'.repeat(200);
    const found = detectNameCues(buildView(`ชื่อ${thai}`));
    expect(found).toHaveLength(1);
    expect((found[0]?.end ?? 0) - (found[0]?.start ?? 0)).toBe(MAX_THAI_TOKEN);
  });

  it('does not read far past a cue: a long gap of spaces ends the match', () => {
    expect(redact(`my name is${' '.repeat(50)}Somchai`)).toBe(`my name is${' '.repeat(50)}Somchai`);
  });

  it('refuses a text with too many cues (fail closed)', () => {
    const text = 'Mr A '.repeat(MAX_CUE_MATCHES + 1);
    expect(() => detectNameCues(buildView(text))).toThrow(NameMatchLimitError);
  });

  it('is linear on hostile input', () => {
    const inputs = [
      'my name is '.repeat(40_000),
      'thanks '.repeat(100_000),
      `${'dear '.repeat(5_000)}${' '.repeat(500_000)}`,
      'คุณ'.repeat(30_000),
      `Mr ${'Ab '.repeat(300_000)}`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      try {
        detectNameCues(buildView(input.slice(0, 600_000)));
      } catch (error) {
        expect(error).toBeInstanceOf(NameMatchLimitError);
      }
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
});

describe('role-play payload (OPS-1006): no raw name reaches the model', () => {
  const body = [
    'Hello,',
    'My name is Somchai Jaidee and our portal export keeps failing.',
    'Please call me on 081-234-5678 or write to somchai@example.com.',
    '',
    'Best regards,',
    'Somchai Jaidee',
    'Acme Co.',
  ].join('\n');

  it('redacts the introduced name and the signature', () => {
    const redacted = redact(body);
    expect(redacted).not.toContain('Somchai');
    expect(redacted).not.toContain('Jaidee');
    expect(redacted).not.toContain('081-234-5678');
    expect(redacted).not.toContain('example.com');
    expect(redacted).toContain('My name is [NAME_1] [NAME_2]');
    expect(redacted).toContain('Best regards,\n[NAME_1] [NAME_2]\nAcme Co.');
  });

  it('round-trips for staff', () => {
    const session = redactor.session({ scope: 'ticket:rp' });
    const redacted = session.redact(body);
    expect(session.restore(redacted, 'internal').text).toBe(body);
  });

  it('does the same in Thai', () => {
    const thai = 'สวัสดีครับ ผมชื่อสมชาย ใจดี ส่งออกรายงานไม่ได้\nขอบคุณครับ\nคุณสมชาย ใจดี';
    const redacted = redact(thai);
    expect(redacted).not.toContain('สมชาย');
    expect(redacted).not.toContain('ใจดี');
    expect(redacted).toContain('ขอบคุณครับ');
  });
});
