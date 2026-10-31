import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditOutcome } from '@watchtower/shared';
import type { Request, Response } from 'express';
import { defer, from, lastValueFrom, type Observable } from 'rxjs';

import { AUDIT_KEY, type AuditedOptions } from '../auth/decorators.js';
import { principalOf } from '../auth/principal.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { AuditScope, type AuditActor } from './audit-scope.js';
import { AuditService } from './audit.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function errorInfo(error: unknown): { status: number; code: string | null } {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const code =
      typeof body === 'object' && 'code' in body && typeof body.code === 'string'
        ? body.code
        : null;
    return { status: error.getStatus(), code };
  }
  return { status: 500, code: null };
}

/**
 * Writes one audit row for every mutating request (POST, PUT, PATCH, DELETE) and for any route
 * marked `@Audited({ always: true })` or `@AuditPiiRead`, whether the handler succeeded or threw.
 * Global (APP_INTERCEPTOR), so a new mutation route is audited without anyone remembering to ask.
 *
 * Requests a guard rejects never reach an interceptor; AuthGuard records those itself.
 *
 * If the row cannot be written after a successful mutation the request fails with 500: the change
 * happened but is not on the log, which an operator must see rather than have hidden. Handlers
 * whose change must be atomic with its audit row use `AuditService.recordInTransaction`.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const options = this.reflector.getAllAndOverride<AuditedOptions | undefined>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (SAFE_METHODS.has(request.method) && options?.always !== true) return next.handle();

    const scope = new AuditScope();
    return defer(() => from(this.audited(request, response, options, scope, next)));
  }

  private async audited(
    request: Request,
    response: Response,
    options: AuditedOptions | undefined,
    scope: AuditScope,
    next: CallHandler,
  ): Promise<unknown> {
    let value: unknown;
    try {
      // `next.handle()` binds the async context of whoever calls it, so it must be called inside
      // the scope: that is what lets services the handler calls reach this request's AuditScope.
      value = await AuditScope.run(scope, () =>
        lastValueFrom(next.handle() as Observable<unknown>, { defaultValue: undefined }),
      );
    } catch (error) {
      await this.write(request, response, options, scope, errorInfo(error), true).catch(
        (writeError: unknown) => {
          this.logger.error({ err: writeError }, 'audit write failed after a failed request');
        },
      );
      throw error;
    }
    await this.write(request, response, options, scope, { status: response.statusCode });
    return value;
  }

  private async write(
    request: Request,
    response: Response,
    options: AuditedOptions | undefined,
    scope: AuditScope,
    result: { status: number; code?: string | null },
    failed = false,
  ): Promise<void> {
    const details = scope.read();
    if (details.persisted === true) return;

    const principal = principalOf(request);
    const actor: AuditActor =
      details.actor ??
      (principal ? { type: 'user', id: principal.userId } : { type: 'anonymous', id: null });
    const route =
      typeof request.route === 'object' ? (request.route as { path?: unknown }).path : undefined;
    const routePath = typeof route === 'string' ? route : request.path;
    const rawRequestId = response.getHeader('x-request-id');
    const outcome: AuditOutcome =
      details.outcome ?? (!failed ? 'success' : result.status === 403 ? 'denied' : 'failure');
    const paramId = request.params.id;

    try {
      await this.audit.record({
        actor,
        action: details.action ?? options?.action ?? `http.${request.method} ${routePath}`,
        outcome,
        targetType: details.targetType ?? options?.targetType ?? null,
        targetId: details.targetId ?? (typeof paramId === 'string' ? paramId : null),
        before: details.before,
        after: details.after,
        ip: request.ip ?? null,
        requestId: typeof rawRequestId === 'string' ? rawRequestId : null,
        metadata: {
          method: request.method,
          route: routePath,
          status: result.status,
          ...(result.code ? { errorCode: result.code } : {}),
          ...details.metadata,
        },
      });
    } catch (error) {
      if (failed) throw error;
      this.logger.error(
        { err: error, action: details.action ?? options?.action },
        'audit write failed',
      );
      throw new InternalServerErrorException('The change was made but could not be audited');
    }
  }
}
