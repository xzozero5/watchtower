import type { commandsEn } from '../en/commands';
import type { Widen } from '../types';

export const commandsTh: Widen<typeof commandsEn> = {
  focusSearch: 'ค้นหาในคิวงาน',
  goTicket: 'ไปที่ ticket {key}',
  goHome: 'ไปที่หน้าหลัก',
  goAdmin: 'ไปที่ผู้ดูแลระบบ › {section}',
  goShift: 'ไปที่กะงาน › {section}',
  aiStop: 'AI: หยุด AI ทั้งหมด…',
  aiResume: 'AI: ให้ AI ทำงานต่อ…',
  aiLimit: 'AI: จำกัดทุก intent ไม่เกินขั้น 2…',
  aiUnlimit: 'AI: ยกเลิกการจำกัดขั้น…',
  askAssistant: 'ถาม AI',
  ticketStatus: 'Ticket: เปลี่ยนสถานะ',
  ticketPriority: 'Ticket: เปลี่ยนความสำคัญ',
  ticketAssign: 'Ticket: มอบหมาย…',
  showShortcuts: 'แสดงคีย์ลัด',
  signOut: 'ออกจากระบบ',
  themeSystem: 'ธีม: ตามระบบ',
  themeLight: 'ธีม: สว่าง',
  themeDark: 'ธีม: มืด',
  densityComfortable: 'ความหนาแน่น: สบายตา',
  densityCompact: 'ความหนาแน่น: กะทัดรัด',
  languageEnglish: 'ภาษา: English',
  languageThai: 'ภาษา: ไทย',
  singleKeyOn: 'คีย์ลัดปุ่มเดี่ยว: เปิด',
  singleKeyOff: 'คีย์ลัดปุ่มเดี่ยว: ปิด',
};
