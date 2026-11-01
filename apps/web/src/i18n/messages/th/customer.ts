import type { customerEn } from '../en/customer';
import type { Widen } from '../types';

export const customerTh: Widen<typeof customerEn> = {
  requester: 'ผู้แจ้ง',
  email: 'อีเมล',
  noRequester: 'ticket นี้ไม่มีข้อมูลผู้แจ้ง',
};
