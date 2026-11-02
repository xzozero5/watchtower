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
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  type DialogContentProps,
} from './components/dialog.js';
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTrigger,
  type SheetContentProps,
} from './components/sheet.js';
export {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
  type DataTableSort,
} from './components/data-table.js';
export { Breadcrumb, type BreadcrumbItem, type BreadcrumbProps } from './components/breadcrumb.js';
export {
  AUTONOMY_STAGES,
  StageBadge,
  type AutonomyStage,
  type StageBadgeProps,
} from './components/stage-badge.js';
export { SeverityBadge, type SeverityBadgeProps } from './components/severity-badge.js';
export { IconButton, type IconButtonProps } from './components/icon-button.js';
export { TintChip, type ChipIcon, type TintChipProps } from './components/tint-chip.js';
export { TINT_CLASSES } from './components/tint.js';
export {
  INTENT_TINTS,
  IntentChip,
  intentIcon,
  intentTint,
  type IntentChipProps,
} from './components/intent-chip.js';
export {
  CONFIDENCE_DOTS,
  ConfidenceDots,
  litDots,
  type ConfidenceDotsProps,
} from './components/confidence-dots.js';
export { SectionHeading, type SectionHeadingProps } from './components/section-heading.js';
export { HelpHint, type HelpHintProps } from './components/help-hint.js';
export { FlagIcon, type FlagCode } from './components/flag-icon.js';
export {
  LanguageFlags,
  type LanguageFlagOption,
  type LanguageFlagsProps,
} from './components/language-flags.js';
export { ThemeSwitch, type ThemeSwitchProps } from './components/theme-switch.js';
export { BarChart, type BarChartDatum, type BarChartProps } from './components/bar-chart.js';
export { BarList, type BarListDatum, type BarListProps } from './components/bar-list.js';
export {
  ChartFrame,
  type ChartFrameProps,
  type ChartTableLabels,
  type ChartTableView,
} from './components/chart-frame.js';
export {
  BAR_GAP,
  BAR_MAX_THICKNESS,
  BAR_RADIUS,
  columnLayout,
  columnPath,
  countTicks,
  labelIndexes,
  niceCeil,
  rowPath,
  slotAt,
} from './components/chart-geometry.js';
export { StatTile, type StatTileProps, type StatTileState } from './components/stat-tile.js';
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
  CHART_CHANNELS,
  CHART_ORDINAL_STEPS,
  COLOR_TOKENS,
  RADIUS_TOKENS,
  SHADOW_TOKENS,
  THEME_NAMES,
  TINT_IDS,
  type AvatarColors,
  type ChartChannel,
  type ChartColors,
  type ColorTokens,
  type SeverityColors,
  type ShadowTokens,
  type ThemeName,
  type TintColors,
  type TintId,
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
export { AppFrame } from './components/app-frame.js';
export {
  Card,
  CardHeader,
  HighlightCard,
  type CardHeaderProps,
  type CardProps,
} from './components/card.js';
export {
  TrendChip,
  type TrendChipProps,
  type TrendDirection,
  type TrendMeaning,
} from './components/trend-chip.js';
