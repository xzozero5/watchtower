import type { paletteEn } from '../en/palette';
import type { Widen } from '../types';

export const paletteTh: Widen<typeof paletteEn> = {
  title: 'แผงคำสั่ง',
  description: 'พิมพ์เพื่อกรองคำสั่ง ใช้ปุ่มลูกศรเลื่อน และกด Enter เพื่อสั่งงาน',
  placeholder: 'พิมพ์คำสั่ง',
  listLabel: 'คำสั่ง',
  empty: 'ไม่พบคำสั่งที่ตรงกัน',
  emptyHint: 'ลองคำอื่น เช่น "ธีม" หรือ "ภาษา"',
  groups: {
    general: 'ทั่วไป',
    display: 'การแสดงผล',
    language: 'ภาษา',
    admin: 'ผู้ดูแลระบบ',
  },
};
