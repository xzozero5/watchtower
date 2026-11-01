import { INBOUND_PUBLIC_ROUTES } from './inbound/public-routes.js';
import { OUTBOUND_PUBLIC_ROUTES } from './outbound/public-routes.js';
import { GMAIL_PUBLIC_ROUTES } from './gmail/public-routes.js';
import { LINE_PUBLIC_ROUTES } from './line/public-routes.js';
import { DISCORD_PUBLIC_ROUTES } from './discord/public-routes.js';
import { NOTIFICATIONS_PUBLIC_ROUTES } from './notifications/public-routes.js';
import { AI_PUBLIC_ROUTES } from './ai/public-routes.js';
import { KB_PUBLIC_ROUTES } from './kb/public-routes.js';
import { CSAT_PUBLIC_ROUTES } from './csat/public-routes.js';
import { SHIFTS_PUBLIC_ROUTES } from './shifts/public-routes.js';
import { AUTONOMY_PUBLIC_ROUTES } from './autonomy/public-routes.js';
import { CREDENTIALS_PUBLIC_ROUTES } from './credentials/public-routes.js';
import { VIEWS_PUBLIC_ROUTES } from './views/public-routes.js';
import { ALERTS_PUBLIC_ROUTES } from './alerts/public-routes.js';
import { STATUSPAGE_PUBLIC_ROUTES } from './statuspage/public-routes.js';

/** Public routes of every Phase 1 feature module, read by the route-policy test (T-123a). */
export const FEATURE_PUBLIC_ROUTES: readonly string[] = [
  ...INBOUND_PUBLIC_ROUTES,
  ...OUTBOUND_PUBLIC_ROUTES,
  ...GMAIL_PUBLIC_ROUTES,
  ...LINE_PUBLIC_ROUTES,
  ...DISCORD_PUBLIC_ROUTES,
  ...NOTIFICATIONS_PUBLIC_ROUTES,
  ...AI_PUBLIC_ROUTES,
  ...KB_PUBLIC_ROUTES,
  ...CSAT_PUBLIC_ROUTES,
  ...SHIFTS_PUBLIC_ROUTES,
  ...AUTONOMY_PUBLIC_ROUTES,
  ...CREDENTIALS_PUBLIC_ROUTES,
  ...VIEWS_PUBLIC_ROUTES,
  ...ALERTS_PUBLIC_ROUTES,
  ...STATUSPAGE_PUBLIC_ROUTES,
];
