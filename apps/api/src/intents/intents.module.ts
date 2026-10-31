import { Module } from '@nestjs/common';

import { IntentsController } from './intents.controller.js';
import { IntentsService } from './intents.service.js';

/** The intent taxonomy (PRD section 3.1). Rows come from the seed code; nothing is built in. */
@Module({
  controllers: [IntentsController],
  providers: [IntentsService],
  exports: [IntentsService],
})
export class IntentsModule {}
