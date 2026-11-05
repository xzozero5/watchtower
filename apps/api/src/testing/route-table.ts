import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { AppModule } from '../app.module.js';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  WORKSPACE_ONLY_KEY,
} from '../auth/decorators.js';
import { DATABASE } from '../database/database.module.js';
import { createLogger } from '../logging/logger.js';
import { REDIS } from '../redis/redis.module.js';
import { testConfig } from './support.js';

// Every route of every controller of the real module graph (infrastructure faked, no network), with what its
// decorators ask for. Shared by the routes policy test and the assistant tool parity test.

export interface RouteInfo {
  readonly key: string;
  readonly controller: string;
  readonly method: string;
  readonly isPublic: boolean;
  readonly permissions: readonly string[];
  readonly anyOf: readonly string[];
  readonly unsafe: boolean;
  /** `@WorkspaceOnly()`: the guard refuses client and system before it looks at permissions. */
  readonly workspaceOnly: boolean;
}

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

export async function collectRoutes(): Promise<RouteInfo[]> {
  const config = testConfig();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config, createLogger(config))],
  })
    .overrideProvider(DATABASE)
    .useValue({ db: {}, pool: {}, ping: () => Promise.resolve(), close: () => Promise.resolve() })
    .overrideProvider(REDIS)
    .useValue({
      ping: () => Promise.resolve('PONG'),
      quit: () => Promise.resolve('OK'),
      disconnect: () => undefined,
    })
    .compile();

  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const routes: RouteInfo[] = [];
  for (const module of moduleRef.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      if (!controller) continue;
      const prefix = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
      for (const name of scanner.getAllMethodNames(controller.prototype as object)) {
        const handler = (controller.prototype as Record<string, unknown>)[name] as Type;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (path === undefined || verb === undefined) continue;
        const method = METHODS[verb] ?? String(verb);
        const targets = [handler, controller];
        routes.push({
          key: `${method} /${[prefix, path]
            .join('/')
            .replace(/\/+/g, '/')
            .replace(/^\/|\/$/g, '')}`,
          controller: controller.name,
          method,
          isPublic: reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true,
          permissions:
            reflector.getAllAndOverride<readonly string[] | undefined>(PERMISSIONS_KEY, targets) ??
            [],
          anyOf:
            reflector.getAllAndOverride<readonly string[] | undefined>(
              ANY_PERMISSIONS_KEY,
              targets,
            ) ?? [],
          unsafe: !['GET', 'HEAD', 'OPTIONS'].includes(method),
          workspaceOnly:
            reflector.getAllAndOverride<boolean | undefined>(WORKSPACE_ONLY_KEY, targets) === true,
        });
      }
    }
  }
  await moduleRef.close();
  return routes;
}
