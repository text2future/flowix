export const FLOWIX_TEXT_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;

export type FlowixTextColor = (typeof FLOWIX_TEXT_COLORS)[number];

export function isFlowixTextColor(value: unknown): value is FlowixTextColor {
  return typeof value === 'string'
    && (FLOWIX_TEXT_COLORS as readonly string[]).includes(value);
}


/** Shared CSS token reference; persisted content contains only the color identifier. */
export function flowixHighlightBackground(color: FlowixTextColor): string {
  return `var(--flowix-highlight-background-${color})`;
}
