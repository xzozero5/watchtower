import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  compileProcedureResultSchema,
  createProcedureVersionSchema,
  intentProcedureParamsSchema,
  procedureSimulateQueuedSchema,
  procedureSimulationAnswerSchema,
  procedureValidationSchema,
  procedureVersionListSchema,
  procedureVersionParamsSchema,
  procedureVersionResultSchema,
  procedureVersionSchema,
  updateProcedureVersionSchema,
  type CreateProcedureVersion,
  type UpdateProcedureVersion,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { ProceduresService } from './procedures.service.js';

type IntentParams = z.infer<typeof intentProcedureParamsSchema>;
type VersionParams = z.infer<typeof procedureVersionParamsSchema>;

const actorOf = (principal: Principal) => ({ type: 'user', id: principal.userId }) as const;

/**
 * The procedure of an intent (T-303b, ADR-026): natural-language text, steps the AI compiles from it, a
 * person's confirmation, and a published version. Reading needs `procedure.read` (agent, lead, head, dev);
 * writing, compiling and confirming `procedure.author`; publishing and retiring `procedure.publish`
 * (lead, head) `[ASSUMED]`. A version is frozen when it leaves draft. Every write also writes its own audit
 * row in the same transaction (the decorators name the action for the request-level fallback).
 */
@ApiTags('procedures')
@Controller('v1/intents/:id/procedure/versions')
export class ProceduresController {
  constructor(@Inject(ProceduresService) private readonly procedures: ProceduresService) {}

  @Get()
  @RequirePermission('procedure.read')
  @ApiOperation({
    summary: 'Versions of the procedure of an intent, newest first',
    description:
      'At most 100. `publishedVersionId` is the version the intent runs now; null means the default ' +
      'runbook. Each version carries the latest simulation (publishing needs one that passed).',
  })
  @ApiOkResponse({ standardSchema: procedureVersionListSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.read`' })
  @ApiNotFoundResponse({ description: 'No such intent' })
  async list(@Param({ schema: intentProcedureParamsSchema }) params: IntentParams) {
    return parseResponse(procedureVersionListSchema, await this.procedures.list(params.id));
  }

  @Get(':versionId')
  @RequirePermission('procedure.read')
  @ApiOperation({ summary: 'One version: the text, the steps and where it stands' })
  @ApiOkResponse({ standardSchema: procedureVersionSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.read`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  async get(@Param({ schema: procedureVersionParamsSchema }) params: VersionParams) {
    return parseResponse(
      procedureVersionSchema,
      await this.procedures.get(params.id, params.versionId),
    );
  }

  @Get(':versionId/validation')
  @RequirePermission('procedure.read')
  @ApiOperation({
    summary: 'What is wrong with the steps of a version',
    description:
      'Checks the steps against this instance: tools the intent may use, templates and team queues that ' +
      'exist, evidence from earlier steps, steps that can never run. Confirming needs `ok`.',
  })
  @ApiOkResponse({ standardSchema: procedureValidationSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.read`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  async validation(@Param({ schema: procedureVersionParamsSchema }) params: VersionParams) {
    return parseResponse(
      procedureValidationSchema,
      await this.procedures.validation(params.id, params.versionId),
    );
  }

  @Post()
  @RequirePermission('procedure.author')
  @Audited({ action: AUDIT_ACTIONS.procedureDraftSaved, targetType: 'procedure_version' })
  @ApiOperation({
    summary: 'Start a draft version (the first one creates the procedure)',
    description:
      'Send the text, the steps, or both. Steps are strict: a field the schema does not have is refused. ' +
      'A draft does nothing until it is confirmed, simulated and published.',
  })
  @ApiCreatedResponse({ standardSchema: procedureVersionSchema })
  @ApiBadRequestResponse({ description: 'The body does not fit the schema' })
  @ApiForbiddenResponse({ description: 'Needs `procedure.author`' })
  @ApiNotFoundResponse({ description: 'No such intent' })
  async create(
    @Param({ schema: intentProcedureParamsSchema }) params: IntentParams,
    @Body({ schema: createProcedureVersionSchema }) body: CreateProcedureVersion,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      procedureVersionSchema,
      await this.procedures.create(actorOf(principal), params.id, body),
    );
  }

  @Patch(':versionId')
  @RequirePermission('procedure.author')
  @Audited({ action: AUDIT_ACTIONS.procedureDraftSaved, targetType: 'procedure_version' })
  @ApiOperation({
    summary: 'Edit a draft (text, steps or both)',
    description: 'Only a draft changes. Anything that left draft is frozen: write a new version.',
  })
  @ApiOkResponse({ standardSchema: procedureVersionSchema })
  @ApiBadRequestResponse({ description: 'The body does not fit the schema' })
  @ApiForbiddenResponse({ description: 'Needs `procedure.author`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  @ApiConflictResponse({ description: 'The version is not a draft' })
  async update(
    @Param({ schema: procedureVersionParamsSchema }) params: VersionParams,
    @Body({ schema: updateProcedureVersionSchema }) body: UpdateProcedureVersion,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      procedureVersionSchema,
      await this.procedures.update(actorOf(principal), params.id, params.versionId, body),
    );
  }

  @Post(':versionId/compile')
  @HttpCode(200)
  @RequirePermission('procedure.author')
  @Audited({ action: AUDIT_ACTIONS.procedureCompiled, targetType: 'procedure_version' })
  @ApiOperation({
    summary: 'Have the AI draft the steps from the text (a person confirms afterwards)',
    description:
      'Redacts the text, asks the `procedure_compiler` agent for steps and stores them in the draft, which ' +
      'stays a draft. The answer carries what is wrong with the steps and what the model guessed. Refused ' +
      'with 503 `ai_unavailable` while the AI kill switch is on, the daily budget is used or no provider is ' +
      'set up; the steps can still be written by hand. 502 `ai_unavailable` when the answer did not fit the schema.',
  })
  @ApiOkResponse({ standardSchema: compileProcedureResultSchema })
  @ApiBadRequestResponse({ description: 'The text is empty or over 8 KB' })
  @ApiForbiddenResponse({ description: 'Needs `procedure.author`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  @ApiConflictResponse({ description: 'The version is not a draft' })
  @ApiResponse({ status: 502, description: 'The compiler answered with steps that do not fit' })
  @ApiResponse({ status: 503, description: 'The compiler is not available (`ai_unavailable`)' })
  async compile(
    @Param({ schema: procedureVersionParamsSchema }) params: VersionParams,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      compileProcedureResultSchema,
      await this.procedures.compile(actorOf(principal), params.id, params.versionId),
    );
  }

  @Post(':versionId/confirm')
  @HttpCode(200)
  @RequirePermission('procedure.author')
  @Audited({ action: AUDIT_ACTIONS.procedureConfirmed, targetType: 'procedure_version' })
  @ApiOperation({
    summary: 'Confirm the steps of a draft',
    description:
      'A person reads the steps and confirms them; the version is frozen from here. Refused (400) while the ' +
      'steps have problems or are empty. Simulation (T-303d) and publishing come next.',
  })
  @ApiOkResponse({ standardSchema: procedureVersionResultSchema })
  @ApiBadRequestResponse({ description: 'The steps have problems, or there are none' })
  @ApiForbiddenResponse({ description: 'Needs `procedure.author`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  @ApiConflictResponse({ description: 'The version is not a draft' })
  async confirm(
    @Param({ schema: procedureVersionParamsSchema }) params: VersionParams,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      procedureVersionResultSchema,
      await this.procedures.confirm(actorOf(principal), params.id, params.versionId),
    );
  }

  @Post(':versionId/simulate')
  @HttpCode(202)
  @RequirePermission('procedure.publish')
  @Audited({
    action: AUDIT_ACTIONS.procedureSimulationRequested,
    targetType: 'procedure_version',
  })
  @ApiOperation({
    summary: 'Simulate a confirmed version on resolved tickets before publishing',
    description:
      'Queues a run: the investigator and the drafter work the newest resolved tickets of the intent (30, seeded ' +
      'tickets only to fill up) with these steps and with the version live now, with read-only tools on their own ' +
      'budget. The result (edit distance to the reply a person sent, uncited claims, policy violations, disclosure ' +
      'leaks, steps that never worked) comes with `GET .../simulation`; publishing needs a pass. Refused with 409 ' +
      'unless the version is confirmed or simulated, and 503 `ai_unavailable` while the AI cannot run.',
  })
  @ApiAcceptedResponse({ standardSchema: procedureSimulateQueuedSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.publish`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  @ApiConflictResponse({ description: 'The version is not confirmed or simulated' })
  @ApiResponse({ status: 503, description: 'The AI is not available (`ai_unavailable`)' })
  async simulate(
    @Param({ schema: procedureVersionParamsSchema }) params: VersionParams,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      procedureSimulateQueuedSchema,
      await this.procedures.simulate(actorOf(principal), params.id, params.versionId),
    );
  }

  @Get(':versionId/simulation')
  @RequirePermission('procedure.read')
  @ApiOperation({
    summary: 'The latest simulation of a version',
    description:
      '`simulation` is null while none has finished. It carries the numbers and the cases (ticket id and ' +
      'distances only, never ticket text) and whether it passed.',
  })
  @ApiOkResponse({ standardSchema: procedureSimulationAnswerSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.read`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  async simulation(@Param({ schema: procedureVersionParamsSchema }) params: VersionParams) {
    return parseResponse(
      procedureSimulationAnswerSchema,
      await this.procedures.simulation(params.id, params.versionId),
    );
  }

  @Post(':versionId/publish')
  @HttpCode(200)
  @RequirePermission('procedure.publish')
  @Audited({ action: AUDIT_ACTIONS.procedurePublished, targetType: 'procedure_version' })
  @ApiOperation({
    summary: 'Publish a simulated version (or roll back to one published before)',
    description:
      'The database refuses unless the latest simulation of these exact steps passed and is at most 30 days ' +
      'old (409). The version live now is retired and the intent points at this one. For an intent at stage 3 ' +
      'or more the publisher must not be the person who confirmed, and a simulation on seeded tickets does not ' +
      'count (403).',
  })
  @ApiOkResponse({ standardSchema: procedureVersionSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.publish`, or a stage 3 rule' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  @ApiConflictResponse({ description: 'Wrong status, or no passing recent simulation' })
  async publish(
    @Param({ schema: procedureVersionParamsSchema }) params: VersionParams,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      procedureVersionSchema,
      await this.procedures.publish(actorOf(principal), params.id, params.versionId),
    );
  }

  @Post(':versionId/retire')
  @HttpCode(200)
  @RequirePermission('procedure.publish')
  @Audited({ action: AUDIT_ACTIONS.procedureRetired, targetType: 'procedure_version' })
  @ApiOperation({
    summary: 'Retire a version',
    description:
      'The live version: the intent returns to the default runbook. A draft, confirmed or simulated version: ' +
      'thrown away (kept for the record, never deleted).',
  })
  @ApiOkResponse({ standardSchema: procedureVersionSchema })
  @ApiForbiddenResponse({ description: 'Needs `procedure.publish`' })
  @ApiNotFoundResponse({ description: 'No such version of this intent' })
  @ApiConflictResponse({ description: 'Already retired' })
  async retire(
    @Param({ schema: procedureVersionParamsSchema }) params: VersionParams,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      procedureVersionSchema,
      await this.procedures.retire(actorOf(principal), params.id, params.versionId),
    );
  }
}
