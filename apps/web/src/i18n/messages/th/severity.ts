import type { severityEn } from '../en/severity';
import type { Widen } from '../types';

export const severityTh: Widen<typeof severityEn> = {
  p1: 'วิกฤต',
  p2: 'สูง',
  p3: 'ปานกลาง',
  p4: 'ต่ำ',
  keyTitle: 'ความหมายของระดับความรุนแรง',
  keyHint: 'ทุกระดับมีไอคอนและป้ายชื่อของตัวเอง ไม่ได้แยกด้วยสีอย่างเดียว',
};
