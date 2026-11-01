import type { timelineEn } from '../en/timeline';
import type { Widen } from '../types';

export const timelineTh: Widen<typeof timelineEn> = {
  label: 'ข้อความและเหตุการณ์',
  system: 'ระบบ',
  unknownSender: 'ไม่ทราบผู้ส่ง',
  actorAi: 'AI',
  now: 'ตอนนี้',
  byActor: 'โดย {name}',
  internalHint: 'เห็นได้เฉพาะทีมของคุณ และจะไม่ถูกส่งถึงลูกค้า',
  kinds: {
    customer: 'ข้อความจากลูกค้า',
    reply: 'คำตอบถึงลูกค้า',
    internal: 'บันทึกภายใน',
  },
  delivery: {
    pending: 'กำลังส่งถึงลูกค้า',
    failed: 'ส่งถึงลูกค้าไม่สำเร็จ',
  },
  events: {
    created: 'สร้าง ticket',
    updated: 'อัปเดต ticket',
    statusChanged: 'เปลี่ยนสถานะจาก {from} เป็น {to}',
    assigned: 'เปลี่ยนผู้รับผิดชอบ',
    merged: 'รวมเข้ากับ ticket อื่น',
    mergedInto: 'รวมเข้ากับ {key}',
    mergeReceived: 'มี ticket อื่นถูกรวมเข้ามา',
    mergeReceivedFrom: 'รวม {key} เข้ามาใน ticket นี้',
    reopened: 'เปิด ticket อีกครั้ง',
    slaPaused: 'หยุดนาฬิกา SLA',
    slaResumed: 'เดินนาฬิกา SLA ต่อ',
    slaRecalculated: 'คำนวณเวลา SLA ใหม่',
  },
  copy: 'คัดลอกข้อความ',
  copied: 'คัดลอกข้อความแล้ว',
  quote: 'อ้างอิงในคำตอบ',
  quoted: 'อ้างอิงในคำตอบของคุณแล้ว',
  actions: 'การดำเนินการของข้อความ',
  at: 'ส่งเมื่อ {time}',
};
