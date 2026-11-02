import type { PortalSubmitted } from '@watchtower/shared';

import type { SubmitPayload } from './form-model';
import { classifyPortalError, type PortalClient } from './portal-client';
import type { HumanCheck } from './human-check';

export interface SubmitFlowDeps {
  api: Pick<PortalClient, 'submit'>;
  check: Pick<HumanCheck, 'getProof' | 'fillRemainingMs'>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Sends the request with a solved proof. The proof is only handed out after the minimum fill time,
 * so "too quick" should not happen; if the api still refuses the proof while our own timer says it
 * was early (clock changes), wait out the rest and send the same proof once more. Every other
 * failure is thrown for the page to show, and for a verification failure or a rate limit the page
 * asks the human check for a new challenge. Files, if any, travel with the request (multipart).
 */
export async function submitRequest(
  deps: SubmitFlowDeps,
  payload: SubmitPayload,
  files: readonly File[] = [],
): Promise<PortalSubmitted> {
  const proof = await deps.check.getProof();
  const body = { ...payload, verification: proof };
  const send = () =>
    files.length === 0 ? deps.api.submit(body) : deps.api.submit(body, undefined, files);
  try {
    return await send();
  } catch (error) {
    const early = deps.check.fillRemainingMs();
    if (classifyPortalError(error).kind === 'verification' && early > 0) {
      await (deps.sleep ?? defaultSleep)(early);
      return send();
    }
    throw error;
  }
}
