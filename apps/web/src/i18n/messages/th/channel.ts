import type { channelEn } from '../en/channel';
import type { Widen } from '../types';

export const channelTh: Widen<typeof channelEn> = {
  gmail: 'อีเมล',
  line: 'LINE',
  portal: 'พอร์ทัล',
  discord: 'Discord',
  webhook: 'Webhook',
  internal: 'ภายใน',
  phone: 'โทรศัพท์',
  walk_in: 'มาด้วยตนเอง',
  chat: 'แชต',
  other: 'อื่น ๆ',
};
