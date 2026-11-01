import type { outboundEn } from '../en/outbound';
import type { Widen } from '../types';

/** Thai copy of sending a reply. Same keys as en/outbound.ts. */
export const outboundTh: Widen<typeof outboundEn> = {
  sendingIn: 'จะส่งใน {seconds} วิ',
  undo: 'ยกเลิกการส่ง',
  undone: 'ยกเลิกการส่งแล้ว ยังไม่มีข้อความถึงลูกค้า',
  tooLate: 'ช้าไปแล้ว ระบบกำลังส่งคำตอบนี้',
  undoFailed: 'ยกเลิกไม่สำเร็จ ตรวจบทสนทนาก่อนลองใหม่',
  bar: 'คำตอบที่รอส่ง',
  via: 'ทาง {channel}',
  viaTip: 'คำตอบจะส่งทางช่องทางที่ลูกค้าติดต่อเข้ามา',
  delivery: {
    scheduled: 'รอส่ง',
    cancelled: 'ยกเลิกแล้ว ไม่ได้ส่ง',
    failed: 'ส่งไม่สำเร็จ',
  },
  quota: {
    label: 'ข้อความ LINE เดือนนี้',
    used: 'ใช้แล้ว {used} จาก {limit}',
    usedNoLimit: 'ใช้แล้ว {used}',
    warn: 'โควตา LINE ใกล้หมด ถ้าลูกค้ามีอีเมลให้ใช้อีเมลก่อน',
    exhausted: 'โควตา LINE หมดแล้ว ข้อความ push จะถูกปฏิเสธ ให้ใช้อีเมล',
    unknown: 'ไม่ทราบโควตา LINE',
  },
};
