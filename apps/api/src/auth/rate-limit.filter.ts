import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { RateLimitedError } from './http-errors.js';

/** Adds the Retry-After header to a 429 (an HttpException cannot carry headers by itself). */
@Catch(RateLimitedError)
export class RateLimitFilter implements ExceptionFilter<RateLimitedError> {
  catch(exception: RateLimitedError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
