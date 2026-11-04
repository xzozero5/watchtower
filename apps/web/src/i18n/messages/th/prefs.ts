import type { prefsEn } from '../en/prefs';
import type { Widen } from '../types';

export const prefsTh: Widen<typeof prefsEn> = {
  theme: {
    label: 'ธีม',
    system: 'ตามระบบ',
    light: 'สว่าง',
    dark: 'มืด',
    darkTheme: 'ธีมมืด',
    followSystem: 'ตามระบบ',
  },
  density: { label: 'ความหนาแน่น', comfortable: 'สบายตา', compact: 'กะทัดรัด' },
  language: { label: 'ภาษา' },
  assistantButton: 'ปุ่มผู้ช่วย AI',
  singleKey: {
    label: 'คีย์ลัดปุ่มเดี่ยว',
    hint: 'ปุ่มตัวอักษรและสัญลักษณ์อย่าง J, K และ ? ปิดไว้หากกดโดยไม่ตั้งใจ เช่น เมื่อใช้เสียงสั่งงาน',
  },
};
