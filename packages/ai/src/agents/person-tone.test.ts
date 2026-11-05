import { describe, expect, it } from 'vitest';

import { implicitRankingDrops, personToneCheck } from './person-tone.js';

const WITH_PERSON = { personContext: true, citedUsers: 1 } as const;

describe('personToneCheck: what must be rejected (C-24)', () => {
  // [text, reason]: ranking, evasions of the plain word "best"/"ที่สุด" included.
  const REJECTED: readonly (readonly [string, string])[] = [
    ['[NAME_1] ถืองานมากที่สุด', 'ranking'],
    ['[NAME_1] ถืองานหนักสุด 12 รายการ', 'ranking'],
    ['[NAME_1] ถืองานมากสุดในกะนี้', 'ranking'],
    ['[NAME_1] ปิดงานได้ต่ำสุด', 'ranking'],
    ['งานของ [NAME_1] สูงสุด', 'ranking'],
    ['[NAME_1] อยู่อันดับ 1 ของกะ', 'ranking'],
    ['[NAME_1] ตามหลังเพื่อนร่วมกะ', 'ranking'],
    ['[NAME_1] นำหน้าทีม', 'ranking'],
    ['[NAME_1] อยู่ที่ 1', 'ranking'],
    ['[NAME_1] holds the most tickets', 'ranking'],
    ['[NAME_1] has the lowest closure count', 'ranking'],
    ['[NAME_1] is top of the shift', 'ranking'],
    ['[NAME_1] is at the bottom', 'ranking'],
    ['[NAME_1] is behind on tickets', 'ranking'],
    ['[NAME_1] is ahead of schedule', 'ranking'],
    ['[NAME_1] ranks first', 'ranking'],
    ['[NAME_1] is #1 this week', 'ranking'],
    ['[NAME_1] came 2nd', 'ranking'],
    ['[NAME_1] ถืองานช้ากว่า', 'judgement'],
    ['[NAME_1] ทำงานแย่', 'judgement'],
    ['[NAME_1] ทำได้ดีกว่าเมื่อวาน', 'judgement'],
    ['[NAME_1] เก่งเรื่อง P1', 'judgement'],
    ['[NAME_1] is performing better', 'judgement'],
    ['[NAME_1] is worse at closing', 'judgement'],
    ['[NAME_1] is slow today', 'judgement'],
    ['[NAME_1] did a great job', 'judgement'],
    ['ควรย้ายงานจาก [NAME_1]', 'advice'],
    ['ควรคุยกับ [NAME_1]', 'advice'],
    ['[NAME_1] ต้องปิดงานก่อน 17:00', 'advice'],
    ['แนะนำให้ช่วย [NAME_1]', 'advice'],
    ['[NAME_1] should hand over tickets', 'advice'],
    ['[NAME_1] must close 3 tickets', 'advice'],
    ['We recommend moving work from [NAME_1]', 'advice'],
    ['[NAME_1] needs to reply to 3 tickets', 'advice'],
    ['[NAME_1] ถืองานมากกว่าค่าเฉลี่ยทีม', 'comparison'],
    ['[NAME_1] ถืองาน 3 เท่าของอีกคน', 'comparison'],
    ['[NAME_1] ถืองานมากกว่า [NAME_2]', 'multi_person'],
    ['[NAME_1] และ [NAME_2] ถืองาน 9 และ 3 รายการ', 'multi_person'],
    ['[NAME_1] holds more than [NAME_2]', 'multi_person'],
    ['[NAME_1] is above the team average', 'comparison'],
    ['[NAME_1] holds 3x the tickets of others', 'comparison'],
    ['[NAME_1] holds more tickets than the team', 'comparison'],
    ['[NAME_1] holds twice as many tickets', 'comparison'],
    ['[NAME_1] closed fewer than anyone else', 'comparison'],
    ['Compared with last week [NAME_1] holds 9', 'comparison'],
  ];
  for (const [text, reason] of REJECTED) {
    it(`rejects "${text}" as ${reason}`, () => {
      const result = personToneCheck(text, WITH_PERSON);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    });
  }

  it('catches the evasions with spaces, case and zero-width characters', () => {
    expect(personToneCheck('[NAME_1] ถืองานหนัก สุด', WITH_PERSON).ok).toBe(false);
    expect(personToneCheck('[NAME_1] ถืองาน ที่​ สุด', WITH_PERSON).ok).toBe(false);
    expect(personToneCheck('[NAME_1] HOLDS THE MOST', WITH_PERSON).ok).toBe(false);
    expect(personToneCheck('[NAME_1] ถือ ๓ เท่า ของ อีกคน', WITH_PERSON).ok).toBe(false);
  });

  it('catches a comparison with the average when the user is only cited, not named (C-25 self)', () => {
    expect(personToneCheck('คุณถืองานมากกว่าค่าเฉลี่ยทีม', { personContext: true }).ok).toBe(false);
    expect(personToneCheck('You hold more than the team average', { personContext: true }).ok).toBe(
      false,
    );
    expect(personToneCheck('You are doing well', { personContext: true }).ok).toBe(true);
    expect(personToneCheck('You are doing good', { personContext: true }).ok).toBe(false);
  });

  it('rejects two cited users together with one name (a comparison by citation)', () => {
    const result = personToneCheck('[NAME_1] ถืองาน 9 รายการ', {
      personContext: true,
      citedUsers: 2,
    });
    expect(result).toMatchObject({ ok: false, reason: 'multi_person' });
  });
});

describe('personToneCheck: neutral facts pass', () => {
  const OK: readonly string[] = [
    '[NAME_1] ถืองานอยู่ 12 รายการ โดย 3 รายการใกล้ครบกำหนด SLA',
    '[NAME_1] อยู่กะเช้า ถืองาน 5 รายการ',
    'ทีมถืองานรวม 40 รายการ มี 3 คนที่ถือเกิน 10 รายการ',
    'รายการล่าสุดอัปเดตเมื่อ 14:00',
    'Data as of the weekend',
    '[NAME_1] holds 12 tickets, 3 of them near the SLA deadline',
    '[NAME_1] is on the morning shift with 5 tickets',
    'The team holds 40 tickets; 3 people hold more than 10',
    'The latest update was at 14:00',
    'ทีมมีตั๋วค้าง 7 รายการ',
    'There are 7 open tickets',
    'อัตราการตอบกลับอยู่ที่ 3 ชั่วโมง',
  ];
  for (const text of OK) {
    it(`accepts "${text}"`, () => {
      expect(personToneCheck(text, WITH_PERSON)).toEqual({ ok: true });
    });
  }

  it('does not flag a team-level mention of the average when no person is in the claim', () => {
    expect(personToneCheck('ค่าเฉลี่ยของทีมคือ 8 รายการ', { personContext: false })).toEqual({
      ok: true,
    });
  });
});

describe('implicitRankingDrops: ranking by the order of the claims', () => {
  it('drops the later claims when different people run strictly down in the order written', () => {
    expect(
      implicitRankingDrops([
        { person: 'u1', value: 9 },
        { person: 'u2', value: 5 },
        { person: 'u3', value: 2 },
      ]),
    ).toEqual([1, 2]);
  });

  it('drops them when the values run strictly up', () => {
    expect(
      implicitRankingDrops([
        { person: 'u1', value: 2 },
        { person: 'u2', value: 5 },
      ]),
    ).toEqual([1]);
  });

  it('ignores claims that are not about one person, equal values and a single person', () => {
    expect(
      implicitRankingDrops([{ person: 'u1', value: 9 }, null, { person: 'u2', value: 9 }]),
    ).toEqual([]);
    expect(
      implicitRankingDrops([
        { person: 'u1', value: 9 },
        { person: 'u1', value: 5 },
      ]),
    ).toEqual([]);
    expect(
      implicitRankingDrops([
        { person: 'u1', value: 5 },
        { person: 'u2', value: 9 },
        { person: 'u3', value: 2 },
      ]),
    ).toEqual([]);
  });
});
