import type { composerEn } from '../en/composer';
import type { Widen } from '../types';

export const composerTh: Widen<typeof composerEn> = {
  label: 'เขียนข้อความ',
  modeGroup: 'ประเภทข้อความ',
  modes: { reply: 'ตอบลูกค้า', note: 'บันทึกภายใน', noteShort: 'บันทึก' },
  hints: {
    replyStaff: 'ลูกค้าจะอ่านข้อความนี้ ส่งทาง{channel}',
    replyClient: 'ข้อความของคุณจะถูกเพิ่มใน ticket นี้ และทีมซัพพอร์ตจะได้รับแจ้ง',
    note: 'เห็นได้เฉพาะทีมของคุณ และจะไม่ถูกส่งถึงลูกค้า',
  },
  template: {
    label: 'แทรกแม่แบบคำตอบ',
    choose: 'แทรกแม่แบบ',
    none: 'ไม่มีแม่แบบสำหรับ intent นี้',
  },
  unresolved: {
    title: 'กรอกตัวแปรให้ครบก่อน',
    body: 'ตัวแปรเหล่านี้ไม่มีค่าสำหรับ ticket นี้: {names}',
  },
  setStatus: { label: 'แล้วเปลี่ยนสถานะเป็น', keep: 'คงสถานะเดิม' },
  submit: {
    reply: 'ส่งคำตอบ',
    replyAndSet: 'ส่งคำตอบและเปลี่ยนเป็น{status}',
    note: 'เพิ่มบันทึก',
  },
  sending: 'กำลังส่ง',
  sent: { reply: 'ส่งคำตอบแล้ว', note: 'เพิ่มบันทึกแล้ว' },
  closed: {
    title: 'ticket นี้ปิดแล้ว',
    body: 'ticket ที่ปิดหรือรวมแล้วไม่รับคำตอบใหม่',
  },
  errors: {
    title: 'ส่งไม่สำเร็จ',
    generic: 'เกิดข้อผิดพลาด ข้อความของคุณยังอยู่ ลองอีกครั้ง',
    network: 'เชื่อมต่อ API ไม่ได้ ข้อความของคุณยังอยู่ ลองอีกครั้ง',
    forbidden: 'คุณไม่มีสิทธิ์ทำสิ่งนี้กับ ticket นี้',
    invalidTransition: 'ticket เปลี่ยนไปสถานะนั้นจากสถานะปัจจุบันไม่ได้',
    ticketNotOpen: 'ticket ปิดหรือรวมแล้ว จึงรับข้อความใหม่ไม่ได้',
    channelNoOutbound:
      'ช่องทางของ ticket นี้ส่งคำตอบจากที่นี่ไม่ได้ ให้บันทึกสิ่งที่แจ้งลูกค้าเป็นบันทึกภายใน',
  },
  noOutbound: {
    title: 'ตอบลูกค้าจากที่นี่ไม่ได้',
    off: ' (ปิดไว้สำหรับ ticket นี้)',
    body: 'ticket นี้มาทาง {channel} ส่งคำตอบจากที่นี่ไม่ได้ ให้บันทึกสิ่งที่แจ้งลูกค้าเป็นบันทึกภายใน',
  },
  fields: { reply: 'คำตอบถึงลูกค้า', note: 'บันทึกภายใน' },
  placeholders: {
    reply: 'เขียนคำตอบ…',
    note: 'เขียนบันทึกถึงทีมของคุณ…',
    client: 'เขียนข้อความ…',
  },
  noteBanner: 'บันทึกภายใน — ไม่ส่งถึงลูกค้า',
  toolbar: {
    label: 'เครื่องมือเขียนข้อความ',
    attach: 'แนบไฟล์',
    aiDraft: 'ให้ AI ร่างให้',
    phase1: 'เร็ว ๆ นี้ใน Phase 1',
    templateSearch: 'ค้นหาแม่แบบ',
  },
};
