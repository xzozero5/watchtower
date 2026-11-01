import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { discord } from '@watchtower/channels';
import { schema, type CredentialStore, type Database } from '@watchtower/db';
import { incidentStatusSchema, parseIncidentKey, type Permission } from '@watchtower/shared';
import { and, asc, eq, like, sql } from 'drizzle-orm';

import { badRequest, unauthenticated } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { RbacService } from '../rbac/rbac.service.js';
import { UnitOfWorkService, type UnitOfWork } from '../realtime/unit-of-work.js';

const {
  INTERACTION_TYPES,
  PONG,
  buildAlertAckedMessage,
  ephemeralReply,
  interactionSchema,
  interactionTimestampFresh,
  interactionUserId,
  parseCustomId,
  toDiscordComponents,
  updateMessage,
  verifyInteractionSignature,
} = discord;
type CommandOption = discord.CommandOption;
type Interaction = discord.Interaction;
type InteractionResponse = discord.InteractionResponse;

const MINUTE = 60;

const serviceUnavailable = (): HttpException =>
  new HttpException(
    { statusCode: 503, error: 'Service Unavailable' },
    HttpStatus.SERVICE_UNAVAILABLE,
  );

interface Handled {
  readonly response: InteractionResponse;
  /** A stable code of what was done, kept with the interaction id. */
  readonly outcome: string;
}

interface Presser {
  readonly id: string;
  readonly discordUserId: string;
  readonly permissions: ReadonlySet<Permission>;
}

const refuse = (outcome: string, text: string): Handled => ({
  response: ephemeralReply(text),
  outcome,
});

/** The value of a named option, looking one level into a sub-command. */
function optionValue(options: readonly CommandOption[] | undefined, name: string): string | null {
  for (const option of options ?? []) {
    if (option.name === name && option.value !== undefined) return String(option.value);
  }
  return null;
}

/**
 * The Discord interactions endpoint (T-202b, R-3.8, R-3.13): buttons on an alert page or an incident
 * thread, and the `/ack` and `/incident` commands. Facts checked against docs.discord.com on 2026-11-02:
 * the request is signed with Ed25519 (`X-Signature-Ed25519` over `X-Signature-Timestamp` + raw body),
 * a bad signature is 401, a PING is answered `{ type: 1 }`, and the first answer is due within 3 seconds.
 *
 * Order, and why:
 *  1. rate limit (cheap, before any crypto);
 *  2. the signature, with the public key from the credential store (env first, then the encrypted
 *     database, ADR-012); nothing is parsed and nothing written until it checks out;
 *  3. a PING is answered at once, with no database access;
 *  4. the interaction id is recorded in the same transaction as what the interaction does, so a retry
 *     of the same id is answered "already handled" and changes nothing, and a failure leaves no trace;
 *  5. the Discord user must be linked to an active member of staff (`users.discord_user_id`): an
 *     unlinked account is refused and nothing changes. Permissions are the member's own.
 *
 * Everything the answer says is an id, an enumeration or a count: no alert title, no ticket subject,
 * no organization (N4). The whole path is one short transaction and no outbound call, so it answers
 * well inside the 3 seconds.
 */
@Injectable()
export class DiscordInteractionsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async handle(input: {
    readonly rawBody: Buffer | undefined;
    readonly signature: string | undefined;
    readonly timestamp: string | undefined;
    readonly ip: string | null;
  }): Promise<InteractionResponse> {
    const started = Date.now();
    const hit = await this.limiter.hit(
      'discord-interactions-ip',
      input.ip ?? 'unknown',
      this.config.ALERT_INGEST_RATE_PER_MINUTE,
      MINUTE,
    );
    if (!hit.allowed) {
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const fields = await this.credentials.resolve('discord');
    const publicKey = fields.publicKey?.value ?? '';
    if (publicKey === '') {
      this.logger.warn('discord interactions: received but no public key is configured');
      throw serviceUnavailable();
    }
    const genuine = verifyInteractionSignature({
      publicKeyHex: publicKey,
      signatureHex: input.signature,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
    });
    // A genuine request that is too old (or too far ahead) is a replay: refused like a bad signature,
    // with the same answer. Handled ids are kept a day, far longer than this window, so a replay is
    // never both fresh and forgotten.
    const fresh = interactionTimestampFresh(input.timestamp, Date.now());
    if (!genuine || !fresh || input.rawBody === undefined) {
      // One answer for every kind of failure; the log says only that it happened.
      this.logger.warn({ fresh }, 'discord interactions: request rejected');
      throw unauthenticated('The request signature is missing or does not match');
    }

    let json: unknown;
    try {
      json = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      throw badRequest('The body is not JSON');
    }
    const parsed = interactionSchema.safeParse(json);
    if (!parsed.success) throw badRequest('The body is not an interaction');
    const interaction = parsed.data;
    if (interaction.type === INTERACTION_TYPES.ping) return PONG;

    const response = await this.uow.run((uow) => this.handleOnce(uow, interaction));
    const elapsed = Date.now() - started;
    if (elapsed > 2000) {
      this.logger.warn(
        { elapsedMs: elapsed },
        'discord interactions: slow answer, 3 s is the limit',
      );
    }
    return response;
  }

  private async handleOnce(
    uow: UnitOfWork,
    interaction: Interaction,
  ): Promise<InteractionResponse> {
    const { tx } = uow;
    const fresh = await tx
      .insert(schema.discordInteraction)
      .values({ id: interaction.id, outcome: 'handling' })
      .onConflictDoNothing()
      .returning({ id: schema.discordInteraction.id });
    if (fresh.length === 0) return ephemeralReply('This was already handled.');
    // Housekeeping: the table keeps a day; an interaction token lives 15 minutes.
    await tx.execute(
      sql`DELETE FROM discord_interaction WHERE ctid IN (
            SELECT ctid FROM discord_interaction
             WHERE handled_at < clock_timestamp() - interval '1 day' LIMIT 100)`,
    );

    const handled = await this.decide(uow, interaction);
    await tx
      .update(schema.discordInteraction)
      .set({ outcome: handled.outcome })
      .where(eq(schema.discordInteraction.id, interaction.id));
    return handled.response;
  }

  private async presserOf(interaction: Interaction): Promise<Presser | null> {
    const discordUserId = interactionUserId(interaction);
    if (discordUserId === null) return null;
    // The Discord account names one user (the column is unique, migration 0047). Looked up by that id
    // alone and then judged, so an inactive or customer row can never be skipped in favour of another
    // that happens to match; if the database ever held two, nobody is picked (fail closed).
    const matches = await this.database.db
      .select({
        id: schema.users.id,
        role: schema.users.role,
        status: schema.users.status,
        permissions: schema.users.permissions,
      })
      .from(schema.users)
      .where(eq(schema.users.discordUserId, discordUserId))
      .limit(2);
    const user = matches.length === 1 ? matches[0] : undefined;
    if (user === undefined || user.status !== 'active' || user.role === 'client') return null;
    const permissions = await this.rbac.effectivePermissions(
      user.role as Parameters<RbacService['effectivePermissions']>[0],
      Array.isArray(user.permissions) ? user.permissions : [],
    );
    return { id: user.id, discordUserId, permissions };
  }

  private async decide(uow: UnitOfWork, interaction: Interaction): Promise<Handled> {
    const presser = await this.presserOf(interaction);
    if (presser === null) {
      // Unmapped (or a customer's account, or a deactivated one): refused, nothing changes.
      return refuse(
        'refused_unlinked',
        'Your Discord account is not linked to a Watchtower user, so nothing was changed.',
      );
    }
    if (interaction.type === INTERACTION_TYPES.component) {
      const action = parseCustomId(interaction.data?.custom_id ?? '');
      if (action === null)
        return refuse('refused_unknown_button', 'That button is not recognised.');
      switch (action.kind) {
        case 'alert.ack':
          return this.ackAlert(uow, presser, action.alertId, true);
        case 'incident.ack':
          return this.ackIncidentAlerts(uow, presser, action.incidentId);
        case 'incident.assign':
          return this.assignIncident(uow, presser, action.incidentId);
      }
    }
    if (interaction.type === INTERACTION_TYPES.command) {
      return this.command(uow, presser, interaction);
    }
    return refuse('refused_unsupported', 'That interaction is not supported.');
  }

  private require(presser: Presser, permission: Permission): Handled | null {
    return presser.permissions.has(permission)
      ? null
      : refuse('refused_forbidden', `You do not have permission to do that (${permission}).`);
  }

  /** `update`: replace the page's message with the acknowledged form (a button press); false: just say so (a command). */
  private async ackAlert(
    uow: UnitOfWork,
    presser: Presser,
    alertId: string,
    update: boolean,
  ): Promise<Handled> {
    const denied = this.require(presser, 'alert.ack');
    if (denied !== null) return denied;
    const actor = { type: 'user', id: presser.id } as const;
    const outcome = await translating(async () =>
      settle(
        uow,
        await this.domain.alerts.ack(uow.tx, domainContext(this.domain, actor), {
          alertId,
          via: 'discord',
        }),
      ),
    ).catch((error: unknown) => {
      if (error instanceof HttpException && error.getStatus() === 404) return null;
      throw error;
    });
    if (outcome === null) return refuse('refused_not_found', 'That alert no longer exists.');

    const [row] = await uow.tx
      .select({
        severity: schema.alert.severity,
        count: schema.alert.count,
        level: schema.alert.escalationLevel,
        ackedBy: schema.alert.ackedBy,
        serviceName: schema.service.name,
      })
      .from(schema.alert)
      .leftJoin(schema.service, eq(schema.service.id, schema.alert.serviceId))
      .where(eq(schema.alert.id, alertId))
      .limit(1);
    if (!outcome.changed) {
      const text =
        outcome.state === 'resolved'
          ? 'That alert is already resolved.'
          : 'Somebody acknowledged that alert first.';
      return { response: ephemeralReply(text), outcome: 'already' };
    }
    if (!update || row === undefined) {
      return { response: ephemeralReply('Acknowledged.'), outcome: 'acked' };
    }
    const message = buildAlertAckedMessage(
      {
        alertId,
        level: row.level,
        target: 'on_shift',
        severity: row.severity as 'critical',
        serviceName: row.serviceName,
        count: row.count,
        fallback: false,
        mentionUserIds: [],
        link: new URL(`/alerts/${alertId}`, this.config.APP_URL).toString(),
      },
      presser.discordUserId,
    );
    return {
      response: updateMessage(
        message.content,
        toDiscordComponents({ ...message, buttons: [], mentionUserIds: [] }),
      ),
      outcome: 'acked',
    };
  }

  private async ackIncidentAlerts(
    uow: UnitOfWork,
    presser: Presser,
    incidentId: string,
  ): Promise<Handled> {
    const denied = this.require(presser, 'alert.ack');
    if (denied !== null) return denied;
    const open = await uow.tx
      .select({ id: schema.alert.id })
      .from(schema.alert)
      .where(and(eq(schema.alert.incidentId, incidentId), eq(schema.alert.state, 'open')))
      .orderBy(asc(schema.alert.firstSeenAt));
    let changed = 0;
    for (const alert of open) {
      const result = await this.ackAlert(uow, presser, alert.id, false);
      if (result.outcome === 'acked') changed += 1;
    }
    return {
      response: ephemeralReply(
        changed === 0
          ? 'No open alerts of this incident.'
          : `Acknowledged ${String(changed)} alert(s).`,
      ),
      outcome: changed === 0 ? 'already' : 'acked',
    };
  }

  private async assignIncident(
    uow: UnitOfWork,
    presser: Presser,
    incidentId: string,
  ): Promise<Handled> {
    const denied = this.require(presser, 'incident.create');
    if (denied !== null) return denied;
    const actor = { type: 'user', id: presser.id } as const;
    try {
      await translating(async () =>
        settle(
          uow,
          await this.domain.incidents.update(uow.tx, domainContext(this.domain, actor), {
            incidentId,
            commanderId: presser.id,
            canResolve: false,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof HttpException)
        return refuse('refused_conflict', 'That incident cannot be changed.');
      throw error;
    }
    return { response: ephemeralReply('You are now the commander.'), outcome: 'assigned' };
  }

  /** `/ack id:<start of the alert id>` and `/incident status|update|resolve number:<INC-12> ...`. */
  private async command(
    uow: UnitOfWork,
    presser: Presser,
    interaction: Interaction,
  ): Promise<Handled> {
    const name = interaction.data?.name;
    const options = interaction.data?.options;
    if (name === 'ack') {
      const prefix = (optionValue(options, 'id') ?? '').toLowerCase();
      if (!/^[0-9a-f-]{6,36}$/.test(prefix))
        return refuse('refused_bad_input', 'Give the first characters of the alert id.');
      const candidates = await uow.tx
        .select({ id: schema.alert.id })
        .from(schema.alert)
        .where(
          and(eq(schema.alert.state, 'open'), like(sql`${schema.alert.id}::text`, `${prefix}%`)),
        )
        .limit(2);
      if (candidates.length === 0)
        return refuse('refused_not_found', 'No open alert starts with that.');
      if (candidates.length > 1 || candidates[0] === undefined) {
        return refuse(
          'refused_ambiguous',
          'More than one open alert starts with that: add characters.',
        );
      }
      return this.ackAlert(uow, presser, candidates[0].id, false);
    }
    if (name === 'incident') {
      const sub = options?.find((option) => option.type === 1);
      if (sub === undefined)
        return refuse('refused_bad_input', 'Use /incident status, update or resolve.');
      const number = parseIncidentKey(optionValue(sub.options, 'number') ?? '');
      if (number === null) return refuse('refused_bad_input', 'Give the incident as INC-12.');
      const [row] = await uow.tx
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .where(eq(schema.incident.number, number))
        .limit(1);
      if (row === undefined) return refuse('refused_not_found', 'No such incident.');
      const actor = { type: 'user', id: presser.id } as const;
      const ctx = domainContext(this.domain, actor);
      try {
        if (sub.name === 'update') {
          const denied = this.require(presser, 'incident.create');
          if (denied !== null) return denied;
          const text = optionValue(sub.options, 'text') ?? '';
          await translating(async () =>
            settle(
              uow,
              await this.domain.incidents.note(uow.tx, ctx, { incidentId: row.id, text }),
            ),
          );
          return { response: ephemeralReply('Note added.'), outcome: 'noted' };
        }
        const wanted =
          sub.name === 'resolve'
            ? 'resolved'
            : incidentStatusSchema.safeParse(optionValue(sub.options, 'value')).data;
        if (wanted === undefined)
          return refuse(
            'refused_bad_input',
            'Give a status: investigating, identified, monitoring or resolved.',
          );
        const denied = this.require(
          presser,
          wanted === 'resolved' ? 'incident.manage' : 'incident.create',
        );
        if (denied !== null) return denied;
        await translating(async () =>
          settle(
            uow,
            await this.domain.incidents.update(uow.tx, ctx, {
              incidentId: row.id,
              status: wanted,
              canResolve: presser.permissions.has('incident.manage'),
            }),
          ),
        );
        return { response: ephemeralReply(`Status is now ${wanted}.`), outcome: 'status' };
      } catch (error) {
        if (error instanceof HttpException)
          return refuse('refused_conflict', 'That change is not allowed now.');
        throw error;
      }
    }
    return refuse('refused_unsupported', 'That command is not supported.');
  }
}
