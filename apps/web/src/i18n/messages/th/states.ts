import type { statesEn } from '../en/states';
import type { Widen } from '../types';

export const statesTh: Widen<typeof statesEn> = {
  denied: {
    title: 'คุณไม่มีสิทธิ์เข้าหน้านี้',
    body: 'ต้องมีบทบาท{role}',
    back: 'กลับไปที่คิวงาน',
  },
};
