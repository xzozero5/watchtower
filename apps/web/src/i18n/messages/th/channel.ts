import type { channelEn } from '../en/channel';
import type { Widen } from '../types';

export const channelTh: Widen<typeof channelEn> = {
  gmail: 'อีเมล',
  line: 'LINE',
  portal: 'พอร์ทัล',
  discord: 'Discord',
  webhook: 'Webhook',
};
