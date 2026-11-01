import type { Messages } from '../en';
import { adminTh } from './admin';
import { aiTh } from './ai';
import { apiStatusTh } from './apiStatus';
import { appTh } from './app';
import { authTh } from './auth';
import { channelTh } from './channel';
import { commandsTh } from './commands';
import { composerTh } from './composer';
import { conversationTh } from './conversation';
import { csatTh } from './csat';
import { customerTh } from './customer';
import { detailsTh } from './details';
import { errorsTh } from './errors';
import { homeTh } from './home';
import { keymapTh } from './keymap';
import { liveTh } from './live';
import { loadingTh } from './loading';
import { loginTh } from './login';
import { notificationsTh } from './notifications';
import { paletteTh } from './palette';
import { panelTh } from './panel';
import { panesTh } from './panes';
import { portalTh } from './portal';
import { prefsTh } from './prefs';
import { queueTh } from './queue';
import { railTh } from './rail';
import { rolesTh } from './roles';
import { severityTh } from './severity';
import { slaTh } from './sla';
import { statesTh } from './states';
import { statusTh } from './status';
import { timelineTh } from './timeline';
import { toastTh } from './toast';
import { topbarTh } from './topbar';
import { workspaceTh } from './workspace';

/** Thai UI copy, one file per namespace. Same keys as `../en`. */
export const th: Messages = {
  app: appTh,
  topbar: topbarTh,
  roles: rolesTh,
  channel: channelTh,
  status: statusTh,
  panes: panesTh,
  queue: queueTh,
  conversation: conversationTh,
  timeline: timelineTh,
  composer: composerTh,
  details: detailsTh,
  sla: slaTh,
  workspace: workspaceTh,
  ai: aiTh,
  live: liveTh,
  keymap: keymapTh,
  auth: authTh,
  login: loginTh,
  severity: severityTh,
  palette: paletteTh,
  commands: commandsTh,
  prefs: prefsTh,
  apiStatus: apiStatusTh,
  rail: railTh,
  panel: panelTh,
  customer: customerTh,
  toast: toastTh,
  loading: loadingTh,
  errors: errorsTh,
  states: statesTh,
  home: homeTh,
  admin: adminTh,
  portal: portalTh,
  notifications: notificationsTh,
  csat: csatTh,
};
