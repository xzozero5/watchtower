import { Global, Module, type DynamicModule } from '@nestjs/common';

import { LOGGER, type AppLogger } from './logger.js';

@Global()
@Module({})
export class LoggingModule {
  static forRoot(logger: AppLogger): DynamicModule {
    return {
      module: LoggingModule,
      providers: [{ provide: LOGGER, useValue: logger }],
      exports: [LOGGER],
    };
  }
}
