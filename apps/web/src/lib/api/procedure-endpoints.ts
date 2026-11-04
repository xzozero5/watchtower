import {
  compileProcedureResultSchema,
  procedureValidationSchema,
  procedureVersionListSchema,
  procedureVersionResultSchema,
  procedureVersionSchema,
  type CreateProcedureVersion,
  type UpdateProcedureVersion,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/** The procedure of an intent (T-303e, ADR-026): `/v1/intents/:id/procedure/versions`. One function per endpoint. */
export function createProcedureEndpoints(client: ApiClient) {
  const id = (value: string) => encodeURIComponent(value);
  const base = (intentId: string) => `/v1/intents/${id(intentId)}/procedure/versions`;
  const one = (intentId: string, versionId: string) => `${base(intentId)}/${id(versionId)}`;

  return {
    procedureVersions: (intentId: string, signal?: AbortSignal) =>
      client.request({
        path: base(intentId),
        schema: procedureVersionListSchema,
        ...withSignal(signal),
      }),

    procedureValidation: (intentId: string, versionId: string, signal?: AbortSignal) =>
      client.request({
        path: `${one(intentId, versionId)}/validation`,
        schema: procedureValidationSchema,
        ...withSignal(signal),
      }),

    createProcedureVersion: (intentId: string, body: CreateProcedureVersion) =>
      client.request({
        method: 'POST',
        path: base(intentId),
        body,
        schema: procedureVersionSchema,
      }),

    updateProcedureVersion: (intentId: string, versionId: string, body: UpdateProcedureVersion) =>
      client.request({
        method: 'PATCH',
        path: one(intentId, versionId),
        body,
        schema: procedureVersionSchema,
      }),

    compileProcedureVersion: (intentId: string, versionId: string) =>
      client.request({
        method: 'POST',
        path: `${one(intentId, versionId)}/compile`,
        body: {},
        schema: compileProcedureResultSchema,
      }),

    confirmProcedureVersion: (intentId: string, versionId: string) =>
      client.request({
        method: 'POST',
        path: `${one(intentId, versionId)}/confirm`,
        body: {},
        schema: procedureVersionResultSchema,
      }),

    publishProcedureVersion: (intentId: string, versionId: string) =>
      client.request({
        method: 'POST',
        path: `${one(intentId, versionId)}/publish`,
        body: {},
        schema: procedureVersionSchema,
      }),

    retireProcedureVersion: (intentId: string, versionId: string) =>
      client.request({
        method: 'POST',
        path: `${one(intentId, versionId)}/retire`,
        body: {},
        schema: procedureVersionSchema,
      }),
  };
}
