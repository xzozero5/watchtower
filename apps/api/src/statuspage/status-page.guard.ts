import { Inject, Injectable, type CanActivate } from '@nestjs/common';

import { notFound } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';

/**
 * The public status page is closed unless the owner opened it (`STATUS_PAGE_PUBLIC=true`, T-200). Closed
 * means every `/v1/status` route answers 404, as if the page did not exist: no component list, no
 * subscription form, no hint that it is there. Opening it is the owner's decision (`[ASK-HUMAN]`).
 */
@Injectable()
export class StatusPagePublicGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: Pick<ApiConfig, 'STATUS_PAGE_PUBLIC'>) {}

  canActivate(): boolean {
    if (!this.config.STATUS_PAGE_PUBLIC) throw notFound();
    return true;
  }
}
