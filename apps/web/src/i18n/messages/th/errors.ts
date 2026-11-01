import type { errorsEn } from '../en/errors';
import type { Widen } from '../types';

export const errorsTh: Widen<typeof errorsEn> = {
  title: 'เกิดข้อผิดพลาด',
  body: 'ไม่สามารถแสดงหน้านี้ได้ งานของคุณไม่ได้ถูกเปลี่ยนแปลง ลองอีกครั้ง',
  retry: 'ลองอีกครั้ง',
  notFoundTitle: 'ไม่พบหน้านี้',
  notFoundBody: 'หน้านี้ไม่มีอยู่หรือถูกย้ายแล้ว',
  backHome: 'กลับไปที่คิวงาน',
};
