import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Headers for every public portal response, errors included (they are set before the handler runs):
 * the page behind a tracking link must not leak its address to other sites (`no-referrer`), and
 * nothing about a ticket may be kept by a shared cache or a browser history entry (`no-store`).
 */
@Injectable()
export class PortalHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
    }
    return next.handle();
  }
}
