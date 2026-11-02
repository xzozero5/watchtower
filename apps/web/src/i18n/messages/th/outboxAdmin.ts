import type { outboxAdminEn } from '../en/outboxAdmin';
import type { Widen } from '../types';

/** Thai copy of the head's outbox screen. Same keys as en/outboxAdmin.ts. */
export const outboxAdminTh: Widen<typeof outboxAdminEn> = {
  title: 'Outbox',
  refresh: 'รีเฟรช',
  help: 'Outbox ส่งงาน (ข้อความที่ต้องส่ง, อีเมลที่รับเข้ามาและต้องประมวลผล) ให้ worker ทำ แถวจะเป็น dead เมื่อลองซ้ำหลายครั้งแล้วยังไม่สำเร็จจึงหยุดลอง',
  helpLabel: 'ข้อมูลเพิ่มเติมเรื่อง outbox',
  health: {
    label: 'สุขภาพของ outbox',
    pending: 'รออยู่',
    dead: 'dead',
    oldest: 'รอนานที่สุด',
    oldestNone: 'ไม่มีงานรอ',
    byQueue: 'แยกตามคิว',
    status: {
      ok: 'ทันเวลา',
      warning: 'ช้า',
      critical: 'ค้าง',
    },
    statusHelp:
      'ช้าเมื่อรอตั้งแต่ {warning} และค้างเมื่อรอตั้งแต่ {critical} relay ตรวจทุกวินาที ถ้ารอนานแปลว่า relay หรือ Redis หยุดทำงาน',
  },
  dead: {
    title: 'แถวที่หยุดลองแล้ว',
    caption: 'แถว outbox ที่เป็น dead',
    empty: 'ไม่มีแถว dead',
    loadMore: 'แสดงเพิ่ม',
    col: {
      when: 'เมื่อ',
      job: 'งาน',
      effect: 'ถ้าส่งซ้ำจะ',
      tries: 'ลองกี่ครั้ง',
      error: 'ข้อผิดพลาดล่าสุด',
    },
    noError: 'ไม่มีข้อผิดพลาดที่บันทึกไว้',
    notReplayable: 'ส่งซ้ำไม่ได้: {reason}',
    resend: 'ส่งซ้ำ',
    resendRow: 'ส่งซ้ำ {job}',
  },
  effect: {
    customer: 'ส่งข้อความถึงลูกค้า',
    customerDetail: 'ticket {ticket} ทาง {channel} ({account})',
    reprocess: 'ประมวลผลข้อความที่รับมาเป็นครั้งแรก',
    reprocessDetail: 'รับทาง {channel} ({account}) อาจเปิด ticket ใหม่',
    reprocessAck: 'ประมวลผลข้อความที่รับมาและตอบรับอัตโนมัติ',
    reprocessAckDetail:
      'รับทาง {channel} ({account}) อาจเปิด ticket ใหม่และส่งข้อความตอบรับอัตโนมัติถึงลูกค้า',
  },
  confirm: {
    title: 'ส่งซ้ำ {job}?',
    customer:
      'อาจมีข้อความส่งถึงลูกค้า: ticket {ticket} ทาง {channel} ({account}) ระบบยังตรวจตามปกติ (ช่วงเวลายกเลิกการส่ง, policy gate) และหน้านี้ไม่แสดงเนื้อความ ต้องเปิด ticket เพื่ออ่าน',
    reprocess:
      'ข้อความที่รับทาง {channel} ({account}) ยังไม่เคยถูกประมวลผล การส่งซ้ำอาจเปิด ticket ใหม่ และไม่มีการส่งอะไรถึงลูกค้า',
    reprocessAck:
      'ข้อความที่รับทาง {channel} ({account}) ยังไม่เคยถูกประมวลผล การส่งซ้ำอาจเปิด ticket ใหม่ และอาจส่งข้อความตอบรับอัตโนมัติถึงลูกค้า โดยยังผ่านการตรวจตามปกติ (policy gate)',
    action: 'ส่งซ้ำ',
    audited: 'การกระทำนี้ถูกบันทึกใน audit log',
  },
  resent: 'ใส่กลับเข้าคิวแล้ว',
  notFound: 'แถวนี้ไม่ได้เป็น dead แล้ว',
};
