import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { orgScopeCondition, schema, type Database } from '@watchtower/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
} from '../auth/decorators.js';
import { conflict } from '../auth/http-errors.js';
import { assertOrgAccess, type Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';

/** A route nobody remembered to protect: the global guard must still refuse it. */
@Controller('test')
export class RogueController {
  @Get('rogue')
  rogue() {
    return { reachable: true };
  }

  @Post('rogue-write')
  rogueWrite() {
    return { reachable: true };
  }
}

const mutateSchema = z.object({ note: z.string() });
const idSchema = z.object({ id: z.string().min(1) });
const orgParamSchema = z.object({ orgId: z.uuid() });

/** Routes that exercise the audit interceptor and the organization scoping helpers. */
@Controller('test')
export class ProbeController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  @Post('mutate')
  @RequirePermission('ticket.handle')
  @Audited({ action: 'test.mutate', targetType: 'widget' })
  mutate(@Body({ schema: mutateSchema }) body: z.infer<typeof mutateSchema>) {
    // A careless service puts credentials into the audit payload; redaction must catch them.
    AuditScope.set({
      targetId: 'widget-1',
      before: { note: 'old', password: 'hunter2-plain', nested: { apiKey: 'k-123', ok: 1 } },
      after: {
        note: body.note,
        refreshToken: 'rt-plain-value',
        header: 'Bearer abc.def.ghi',
        hash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      },
    });
    return { ok: true };
  }

  @Post('unnamed')
  @RequirePermission('ticket.handle')
  unnamed() {
    return { ok: true };
  }

  @Post('boom')
  @RequirePermission('ticket.handle')
  @Audited({ action: 'test.boom' })
  boom(): never {
    throw conflict('it went wrong');
  }

  @Post('atomic')
  @RequirePermission('ticket.handle')
  @Audited({ action: 'test.atomic' })
  async atomic() {
    await this.database.db.transaction(async (tx) => {
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'system', id: 'atomic-test' },
        action: 'test.atomic',
        targetType: 'widget',
        targetId: 'w-atomic',
      });
    });
    return { ok: true };
  }

  @Get('pii/:id')
  @RequirePermission('ticket.read')
  @AuditPiiRead('contact')
  pii(@Param({ schema: idSchema }) params: z.infer<typeof idSchema>) {
    AuditScope.set({ targetId: params.id });
    return { id: params.id, email: 'person@example.com' };
  }

  @Get('plain-read')
  @RequirePermission('ticket.read')
  plainRead() {
    return { ok: true };
  }

  /** What T-005 does for every organization-owned record. */
  @Get('org/:orgId/users')
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
  async orgUsers(
    @Param({ schema: orgParamSchema }) params: z.infer<typeof orgParamSchema>,
    @CurrentPrincipal() principal: Principal,
  ) {
    assertOrgAccess(principal, params.orgId);
    const rows = await this.database.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.orgId, params.orgId),
          orgScopeCondition(schema.users.orgId, principal.orgScope),
        ),
      );
    return { emails: rows.map((row) => row.email) };
  }
}
