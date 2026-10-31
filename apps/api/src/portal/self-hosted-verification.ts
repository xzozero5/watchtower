import { Inject, Injectable } from '@nestjs/common';
import type { HumanChallenge } from '@watchtower/shared';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { REDIS } from '../redis/redis.module.js';
import type {
  HumanVerificationProvider,
  VerificationResult,
  VerificationSubmission,
} from './human-verification.js';
import { PORTAL_KEY_LABELS, derivePortalKey } from './portal-keys.js';
import { checkChallenge, hasWork, issueChallenge } from './pow.js';

/** Extra time a used challenge id stays in Redis beyond its expiry, to cover clock differences. */
const REPLAY_SLACK_SECONDS = 60;

/** Where used challenge ids are remembered. Redis in production; a Map in unit tests. */
export interface ReplayStore {
  /** True when `id` had not been used and now is; false when it was already used. */
  claim(id: string, ttlSeconds: number): Promise<boolean>;
}

export class RedisReplayStore implements ReplayStore {
  constructor(private readonly redis: Redis) {}

  async claim(id: string, ttlSeconds: number): Promise<boolean> {
    // SET NX EX is atomic: of two submissions with the same challenge exactly one gets 'OK'. If Redis
    // is down this rejects and the endpoint fails closed.
    const reply = await this.redis.set(`wt:portal:pow:${id}`, '1', 'EX', ttlSeconds, 'NX');
    return reply === 'OK';
  }
}

export interface SelfHostedSettings {
  readonly key: Buffer;
  readonly difficultyBits: number;
  readonly ttlSeconds: number;
  readonly minFillSeconds: number;
}

/**
 * Proof-of-work + honeypot + minimum fill time (ADR-007). The checks run from cheapest to most
 * expensive, and the challenge is claimed (single use) only after it proved valid work, so garbage
 * costs the server one HMAC and never a Redis write.
 */
export class SelfHostedHumanVerification implements HumanVerificationProvider {
  readonly name = 'pow-sha256';

  constructor(
    private readonly settings: SelfHostedSettings,
    private readonly replay: ReplayStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  challenge(): Promise<HumanChallenge> {
    const issued = issueChallenge(this.settings.key, {
      now: this.clock(),
      ttlSeconds: this.settings.ttlSeconds,
      difficultyBits: this.settings.difficultyBits,
    });
    return Promise.resolve({
      provider: 'pow-sha256',
      challenge: issued.token,
      difficultyBits: issued.difficultyBits,
      issuedAt: issued.issuedAt.toISOString(),
      expiresAt: issued.expiresAt.toISOString(),
      minFillSeconds: this.settings.minFillSeconds,
    });
  }

  async verify(submission: VerificationSubmission): Promise<VerificationResult> {
    if (submission.honeypot !== undefined && submission.honeypot.trim() !== '') {
      return { ok: false, reason: 'honeypot' };
    }
    const { proof } = submission;
    // Unreachable while `pow-sha256` is the only variant of HumanProof; a second provider makes it live.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (proof.provider !== this.name) return { ok: false, reason: 'provider_mismatch' };

    const now = this.clock();
    const checked = checkChallenge(this.settings.key, proof.challenge, now);
    if (!checked.ok) return checked;

    const elapsedSeconds = (now.getTime() - checked.issuedAt.getTime()) / 1000;
    if (elapsedSeconds < this.settings.minFillSeconds) return { ok: false, reason: 'too_fast' };

    // The difficulty is the one the server signed into the challenge, never one the client names.
    if (!hasWork(proof.challenge, proof.nonce, checked.difficultyBits)) {
      return { ok: false, reason: 'insufficient_work' };
    }

    const remaining = Math.ceil((checked.expiresAt.getTime() - now.getTime()) / 1000);
    const fresh = await this.replay.claim(checked.id, remaining + REPLAY_SLACK_SECONDS);
    return fresh ? { ok: true, challengeId: checked.id } : { ok: false, reason: 'replayed' };
  }
}

/** Nest wiring: the settings come from the validated environment. */
@Injectable()
export class SelfHostedHumanVerificationProvider extends SelfHostedHumanVerification {
  constructor(@Inject(APP_CONFIG) config: ApiConfig, @Inject(REDIS) redis: Redis) {
    super(
      {
        key: derivePortalKey(config, PORTAL_KEY_LABELS.proofOfWork),
        difficultyBits: config.PORTAL_POW_DIFFICULTY_BITS,
        ttlSeconds: config.PORTAL_POW_TTL_SECONDS,
        minFillSeconds: config.PORTAL_MIN_FILL_SECONDS,
      },
      new RedisReplayStore(redis),
    );
  }
}
