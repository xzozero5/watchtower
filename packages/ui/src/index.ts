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
export {
  Avatar,
  AVATAR_SIZES,
  avatarHue,
  initialsOf,
  type AvatarProps,
  type AvatarSize,
} from './components/avatar.js';
export { DOT_TONES, Pill, StatusDot, StatusPill, type DotTone } from './components/pill.js';
export { Tooltip, TooltipProvider, type TooltipProps } from './components/tooltip.js';
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from './components/popover.js';
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './components/dropdown-menu.js';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './components/tabs.js';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/segmented-control.js';
export { Separator } from './components/separator.js';
export {
  Combobox,
  type ComboboxOption,
  type ComboboxProps,
  type MultiComboboxProps,
  type SingleComboboxProps,
} from './components/combobox.js';
export { Toaster, toast, type ToasterProps } from './components/toaster.js';
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
  AVATAR_HUE_COUNT,
  COLOR_TOKENS,
  THEME_NAMES,
  type AvatarColors,
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
