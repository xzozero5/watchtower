// Writes dist/tokens.css and dist/tailwind-theme.css from the compiled token modules.
// Runs after tsc, so the CSS can never drift from src/tokens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildTailwindThemeCss, buildTokensCss } from '../dist/index.js';

const distDir = join(import.meta.dirname, '..', 'dist');
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'tokens.css'), buildTokensCss());
writeFileSync(join(distDir, 'tailwind-theme.css'), buildTailwindThemeCss());
