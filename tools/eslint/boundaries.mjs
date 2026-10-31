// Architecture boundaries as lint rules. See docs/04-ARCHITECTURE.md section 3.
// To add a workspace: add one entry to WORKSPACES. boundaries.test.mjs fails until you do.
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import tseslint from 'typescript-eslint';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

// An esquery regex literal, used for the no-restricted-syntax selectors below, cannot contain a
// slash, so every slash in these RegExp sources is written as its hex escape.
const SLASH = String.raw`\x2f`;
const NOT_SLASH = `[^${SLASH}]`;

const MODULE_GROUPS = {
  http: {
    label: 'HTTP',
    modules: [
      '(?:node:)?https?',
      '(?:node:)?http2',
      `@nestjs${SLASH}${NOT_SLASH}+`,
      'express',
      'fastify',
      `@fastify${SLASH}${NOT_SLASH}+`,
      'hono',
      'koa',
      'next',
      'axios',
      'got',
      'ky',
      'node-fetch',
      'superagent',
      'undici',
      'ws',
      'socket[.]io(?:-client)?',
    ],
  },
  persistence: {
    label: 'the database or Redis',
    modules: [
      'drizzle-orm',
      'drizzle-kit',
      'pg',
      `pg-${NOT_SLASH}+`,
      'postgres',
      'pgvector',
      'ioredis',
      'redis',
      'bullmq',
    ],
  },
};

// Globals that would let a package reach the network without going through an injected port.
const HTTP_GLOBALS = ['fetch', 'Request', 'Response', 'Headers', 'XMLHttpRequest', 'WebSocket'];

const SHARED = '@watchtower/shared';

/**
 * The dependency matrix. `allow` lists the workspace packages an entry may import by name; every
 * other workspace is off limits. `forbid` names MODULE_GROUPS it must not know about.
 */
export const WORKSPACES = {
  'apps/web': {
    name: '@watchtower/web',
    allow: ['@watchtower/ui', SHARED],
    forbid: ['persistence'],
  },
  'apps/api': {
    name: '@watchtower/api',
    allow: ['@watchtower/db', '@watchtower/ai', '@watchtower/channels', SHARED],
    forbid: [],
  },
  'apps/worker': {
    name: '@watchtower/worker',
    allow: ['@watchtower/db', '@watchtower/ai', '@watchtower/channels', SHARED],
    forbid: [],
  },
  'packages/shared': { name: SHARED, allow: [], forbid: ['http', 'persistence'] },
  'packages/db': { name: '@watchtower/db', allow: [SHARED], forbid: ['http'] },
  'packages/ai': { name: '@watchtower/ai', allow: [SHARED], forbid: ['http', 'persistence'] },
  'packages/channels': { name: '@watchtower/channels', allow: [SHARED], forbid: ['persistence'] },
  'packages/ui': { name: '@watchtower/ui', allow: [SHARED], forbid: ['persistence'] },
};

const moduleRegexSource = (modules) => `^(?:${modules.join('|')})(?:${SLASH}.*)?$`;

const workspaceFragment = (name) => name.replace('/', SLASH);

/** Each group of specifiers this workspace may not import, with the reason shown to the author. */
function restrictionsFor(dir) {
  const { name, allow, forbid } = WORKSPACES[dir];
  const restrictions = [];

  const others = Object.values(WORKSPACES)
    .map((workspace) => workspace.name)
    .filter((other) => other !== name && !allow.includes(other));
  if (others.length > 0) {
    restrictions.push({
      regex: moduleRegexSource(others.map(workspaceFragment)),
      message: `${dir} may only import these workspace packages: ${allow.join(', ') || 'none'}.`,
    });
  }

  for (const key of forbid) {
    const group = MODULE_GROUPS[key];
    restrictions.push({
      regex: moduleRegexSource(group.modules),
      message: `${dir} must not know about ${group.label}. Accept a port (interface) from the caller instead.`,
    });
  }
  return restrictions;
}

/** no-restricted-imports does not see import(), require() or import types. */
function syntaxRestrictions(restrictions) {
  return restrictions.flatMap(({ regex, message }) =>
    [
      `ImportExpression[source.value=/${regex}/]`,
      `CallExpression[callee.name="require"][arguments.0.value=/${regex}/]`,
      `TSImportType[source.value=/${regex}/]`,
    ].map((selector) => ({ selector, message })),
  );
}

/**
 * Reports a path specifier that leaves the importing file's workspace. Workspaces reach each other
 * only through package names, which restrictionsFor checks.
 *
 * This is plain path arithmetic rather than import-x/no-restricted-paths. That rule resolves
 * package names through node_modules symlinks, so it also rejected allowed imports such as
 * packages/channels importing @watchtower/shared.
 */
const noRelativeEscape = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow path imports that leave the current workspace' },
    schema: [
      {
        type: 'object',
        properties: { workspaceRoot: { type: 'string' } },
        required: ['workspaceRoot'],
        additionalProperties: false,
      },
    ],
    messages: {
      escape:
        '"{{specifier}}" leaves this workspace. Import the other package by name, if the boundary rules allow it.',
    },
  },
  create(context) {
    const { workspaceRoot } = context.options[0];
    const check = (node) => {
      const specifier = node?.value;
      if (typeof specifier !== 'string') return;
      if (!specifier.startsWith('.') && !isAbsolute(specifier)) return;
      const target = resolve(dirname(context.filename), specifier);
      const fromRoot = relative(workspaceRoot, target);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        context.report({ node, messageId: 'escape', data: { specifier } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node.arguments[0]);
        }
      },
    };
  },
};

const watchtowerPlugin = { rules: { 'no-relative-escape': noRelativeEscape } };

/**
 * Builds one config block per workspace.
 * @param {{ rootDir: string }} options the repo root. It is passed explicitly because turbo runs
 *   eslint with each package as cwd.
 */
export function boundaryConfigs({ rootDir }) {
  return Object.entries(WORKSPACES).map(([dir, { forbid }]) => {
    const restrictions = restrictionsFor(dir);
    const rules = {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: restrictions }],
      'no-restricted-syntax': ['error', ...syntaxRestrictions(restrictions)],
      'watchtower/no-relative-escape': ['error', { workspaceRoot: join(rootDir, dir) }],
    };
    if (dir === 'packages/ai' && forbid.includes('http')) {
      rules['no-restricted-globals'] = [
        'error',
        ...HTTP_GLOBALS.map((name) => ({
          name,
          message: 'packages/ai must not know about HTTP. Accept a port from the caller instead.',
        })),
      ];
    }
    return {
      name: `watchtower/boundaries/${dir}`,
      files: [`${dir}/${SOURCE_GLOB}`],
      plugins: { '@typescript-eslint': tseslint.plugin, watchtower: watchtowerPlugin },
      rules,
    };
  });
}
