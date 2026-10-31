export const packageName = '@watchtower/ui';

export { Button, buttonVariants, type ButtonProps } from './components/button.js';
export { Alert, ALERT_TONES, type AlertProps, type AlertTone } from './components/alert.js';
export { EmptyState, type EmptyStateProps } from './components/empty-state.js';
export {
  Input,
  Select,
  Textarea,
  type InputProps,
  type SelectProps,
  type TextareaProps,
} from './components/field.js';
export { Skeleton } from './components/skeleton.js';
export { Kbd } from './components/kbd.js';
export { SeverityBadge, type SeverityBadgeProps } from './components/severity-badge.js';
export { cn } from './lib/cn.js';
export {
  DEFAULT_THEME_PREFERENCE,
  DENSITY_STORAGE_KEY,
  parseDensity,
  parseThemePreference,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  themeInitScript,
  type ThemePreference,
} from './theme/preferences.js';
export {
  COLOR_TOKENS,
  THEME_NAMES,
  type ColorTokens,
  type SeverityColors,
  type ThemeName,
} from './tokens/colors.js';
export {
  AA_TEXT_RATIO,
  AA_UI_RATIO,
  allContrastRequirements,
  contrastRatio,
  contrastRequirements,
  parseHexColor,
  relativeLuminance,
  type ContrastRequirement,
} from './tokens/contrast.js';
export {
  buildTailwindThemeCss,
  buildTokensCss,
  colorVariableNames,
  CSS_VAR_PREFIX,
} from './tokens/css.js';
export {
  DEFAULT_DENSITY,
  DENSITIES,
  DENSITY_TOKENS,
  MOTION_TOKENS,
  type Density,
  type DensityTokens,
} from './tokens/density.js';
export {
  SEVERITIES,
  SEVERITY_IDS,
  type SeverityDefinition,
  type SeverityIconName,
  type SeverityId,
} from './tokens/severity.js';
