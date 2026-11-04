// Architecture boundaries as lint rules. See docs/04-ARCHITECTURE.md section 3.
// To add a workspace: add one entry to WORKSPACES. boundaries.test.mjs fails until you do.
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import tseslint from 'typescript-eslint';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

// An esquery regex literal, used for the no-restricted-syntax selectors below, cannot contain a
// slash, so every slash in these RegExp sources is written as its hex escape.
const SLASH = String.raw`\x2f`;
const NOT_SLASH = `[^${SLASH}]`;

const REDIS_MODULES = ['ioredis', 'redis', 'bullmq'];

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
  redis: { label: 'Redis or BullMQ', modules: REDIS_MODULES },
  persistence: {
    label: 'the database or Redis',
    modules: [
      'drizzle-orm',
      'drizzle-kit',
      'pg',
      `pg-${NOT_SLASH}+`,
      'postgres',
      'pgvector',
      ...REDIS_MODULES,
    ],
  },
};

// Globals that would let a package reach the network without going through an injected port.
const HTTP_GLOBALS = ['fetch', 'Request', 'Response', 'Headers', 'XMLHttpRequest', 'WebSocket'];

const SHARED = '@watchtower/shared';

/**
 * The dependency matrix. `allow` lists the workspace packages an entry may import by name; every
 * other workspace is off limits. `forbid` names MODULE_GROUPS it must not know about.
 * `forbidHttpGlobals` also bans the global `fetch` and friends, which reach the network without an import.
 */
export const WORKSPACES = {
  'apps/web': {
    name: '@watchtower/web',
    allow: ['@watchtower/ui', SHARED],
    forbid: ['persistence'],
  },
  'apps/api': {
    name: '@watchtower/api',
    allow: [
      '@watchtower/db',
      '@watchtower/domain',
      '@watchtower/ai',
      '@watchtower/channels',
      '@watchtower/connectors',
      SHARED,
    ],
    forbid: [],
  },
  'apps/worker': {
    name: '@watchtower/worker',
    allow: [
      '@watchtower/db',
      '@watchtower/domain',
      '@watchtower/ai',
      '@watchtower/channels',
      '@watchtower/connectors',
      SHARED,
    ],
    forbid: [],
  },
  'packages/shared': { name: SHARED, allow: [], forbid: ['http', 'persistence'] },
  'packages/db': { name: '@watchtower/db', allow: [SHARED], forbid: ['http'] },
  'packages/ai': {
    name: '@watchtower/ai',
    allow: [SHARED],
    forbid: ['http', 'persistence'],
    forbidHttpGlobals: true,
  },
  // Writes only (ADR-009): the ticket write logic that api and worker share. It may use the
  // database, but not HTTP, Redis or BullMQ; the policy gate and the notifier are ports.
  'packages/domain': {
    name: '@watchtower/domain',
    allow: ['@watchtower/db', SHARED],
    forbid: ['http', 'redis'],
    forbidHttpGlobals: true,
  },
  'packages/channels': { name: '@watchtower/channels', allow: [SHARED], forbid: ['persistence'] },
  // Read-only clients of GCP, Git and data sources and the alert normalizers (ADR-015). Like
  // channels it knows no database; it knows no other adapter package either.
  'packages/connectors': {
    name: '@watchtower/connectors',
    allow: [SHARED],
    forbid: ['persistence'],
  },
  // The eval runner (T-302): runs the agents on cases and reads past tickets for the replay export. A
  // tool for people, not part of the running system; nothing imports it.
  'evals/runner': {
    name: '@watchtower/eval-runner',
    allow: ['@watchtower/ai', '@watchtower/db', SHARED],
    forbid: ['http'],
  },
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

// N4: a value of the branded type RedactedText may only come from the redactor. The single mint
// point in packages/ai/src/redaction/redacted-text.ts carries the only eslint-disable for this.
//
// Two layers. The syntactic layer needs no type information: it looks for the name RedactedText
// anywhere inside the target type of an `as` / `<T>` assertion, so `as RT.RedactedText`,
// `as RedactedText[]`, `as RedactedText | null`, `as { text: RedactedText }`,
// `as Promise<RedactedText>` and `as import('x').RedactedText` are all caught. The type layer runs
// when the file is linted with type information (every workspace is, through the project
// service): it resolves the target type and looks for the brand inside it, which also catches
// aliases (`type R = RedactedText; x as R`) and re-exported names (`import { RedactedText as T }`).
//
// Residual gap, documented in ADR-008: a cast hidden behind a generic helper written by the
// author (`function cast<T>(v: unknown): T`, `cast<RedactedText>(x)`) and an `any` value assigned
// to a RedactedText binding. `no-unsafe-assignment` (strictTypeChecked) covers the second; code
// review covers the first.
const BRAND_PROPERTY_PREFIX = '__@redactedBrand';
const MAX_TYPE_DEPTH = 6;
const MAX_TYPE_NODES = 400;

function mentionsRedactedTextName(node, seen = new Set()) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((child) => mentionsRedactedTextName(child, seen));
  if (node.type === 'TSTypeReference') {
    const name = node.typeName;
    if (name?.type === 'Identifier' && name.name === 'RedactedText') return true;
    if (name?.type === 'TSQualifiedName' && name.right?.name === 'RedactedText') return true;
  }
  if (node.type === 'TSImportType') {
    const qualifier = node.qualifier;
    if (qualifier?.type === 'Identifier' && qualifier.name === 'RedactedText') return true;
    if (qualifier?.type === 'TSQualifiedName' && qualifier.right?.name === 'RedactedText') {
      return true;
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    if (mentionsRedactedTextName(child, seen)) return true;
  }
  return false;
}

/** True when `type` is, or contains, the RedactedText brand. Bounded in depth and node count. */
function typeContainsBrand(checker, root) {
  const seen = new Set();
  const visit = (type, depth) => {
    if (seen.has(type) || seen.size > MAX_TYPE_NODES || depth > MAX_TYPE_DEPTH) return false;
    seen.add(type);
    if (type.aliasSymbol?.name === 'RedactedText') return true;
    if (type.isUnionOrIntersection()) return type.types.some((member) => visit(member, depth));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    const properties = type.getProperties();
    if (properties.some((property) => property.escapedName.startsWith(BRAND_PROPERTY_PREFIX))) {
      return true;
    }
    if ((type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      const args = checker.getTypeArguments(type);
      if (args.length > 0) return args.some((arg) => visit(arg, depth + 1));
    }
    return (
      properties.some((property) => visit(checker.getTypeOfSymbol(property), depth + 1)) ||
      checker.getIndexInfosOfType(type).some((info) => visit(info.type, depth + 1)) ||
      type
        .getCallSignatures()
        .some((signature) => visit(checker.getReturnTypeOfSignature(signature), depth + 1))
    );
  };
  return visit(root, 0);
}

const noRedactedTextCast = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow casting to RedactedText (N4)' },
    schema: [],
    messages: {
      cast: 'Do not cast to RedactedText (N4). Get it from the redactor: session.redact(), session.redactToolOutput() or session.fromModel().',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const typed = services?.program != null && typeof services.getTypeAtLocation === 'function';
    const checker = typed ? services.program.getTypeChecker() : undefined;
    const check = (node) => {
      const target = node.typeAnnotation;
      if (target.type === 'TSTypeReference' && target.typeName?.name === 'const') return;
      let flagged = mentionsRedactedTextName(target);
      if (!flagged && checker !== undefined) {
        flagged = typeContainsBrand(checker, services.getTypeAtLocation(target));
      }
      if (flagged) context.report({ node, messageId: 'cast' });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const watchtowerPlugin = {
  rules: {
    'no-relative-escape': noRelativeEscape,
    'no-redacted-text-cast': noRedactedTextCast,
  },
};

/**
 * Builds one config block per workspace.
 * @param {{ rootDir: string }} options the repo root. It is passed explicitly because turbo runs
 *   eslint with each package as cwd.
 */
export function boundaryConfigs({ rootDir }) {
  return Object.entries(WORKSPACES).map(([dir, { forbidHttpGlobals }]) => {
    const restrictions = restrictionsFor(dir);
    const rules = {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: restrictions }],
      'no-restricted-syntax': ['error', ...syntaxRestrictions(restrictions)],
      'watchtower/no-relative-escape': ['error', { workspaceRoot: join(rootDir, dir) }],
      'watchtower/no-redacted-text-cast': 'error',
    };
    if (forbidHttpGlobals === true) {
      rules['no-restricted-globals'] = [
        'error',
        ...HTTP_GLOBALS.map((name) => ({
          name,
          message: `${dir} must not know about HTTP. Accept a port from the caller instead.`,
        })),
      ];
    }
    return {
      name: `watchtower/boundaries/${dir}`,
      // The globs are relative to the repo root even when a workspace config re-spreads this
      // array: without basePath they would resolve against that workspace and never match
      // (SR106-N1).
      basePath: rootDir,
      files: [`${dir}/${SOURCE_GLOB}`],
      // A workspace's own eslint config legitimately imports the root config.
      ignores: [`${dir}/eslint.config.mjs`],
      plugins: { '@typescript-eslint': tseslint.plugin, watchtower: watchtowerPlugin },
      rules,
    };
  });
}
