import type { CSSProperties } from 'react';
import {
  getAgentType,
  isThemeAdaptiveAgentIcon,
  THEME_ADAPTIVE_AGENT_ICON_KEYS,
} from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { cn } from '@/lib/utils';

// Keep the component module as a compatibility export for existing desktop
// callers; the predicate itself lives in the dependency-neutral agent catalog.
export { isThemeAdaptiveAgentIcon, THEME_ADAPTIVE_AGENT_ICON_KEYS };

const DEFAULT_AGENT_ICON_COLORS: Partial<Record<AgentTypeKey, string>> = {
  'deepseek-harness': '#484848',
};

export interface AgentIconProps {
  typeKey: AgentTypeKey;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /** Force a monochrome mask, useful when an icon sits on a selected row. */
  color?: string;
  draggable?: boolean;
}

/**
 * Shared agent icon renderer.
 *
 * SVGs loaded through <img> cannot inherit CSS currentColor from the host
 * document. The monochrome agent icons therefore use the SVG as a CSS
 * mask, while the remaining branded icons keep their original SVG colors.
 */
export function AgentIcon({
  typeKey,
  alt = '',
  className,
  style,
  color,
  draggable = false,
}: AgentIconProps) {
  const type = getAgentType(typeKey);

  if (!isThemeAdaptiveAgentIcon(typeKey) && !color) {
    return (
      <img
        src={type.icon}
        alt={alt}
        className={cn(typeKey === 'pi' && 'agent-icon--pi', className)}
        style={style}
        draggable={draggable}
      />
    );
  }

  const maskStyle = {
    ...style,
    ...(color || DEFAULT_AGENT_ICON_COLORS[typeKey]
      ? { '--agent-icon-color': color ?? DEFAULT_AGENT_ICON_COLORS[typeKey] }
      : {}),
    '--agent-icon-src': `url("${type.icon}")`,
  } as CSSProperties & { '--agent-icon-src': string };

  return (
    <span
      className={cn('agent-icon agent-icon--masked', typeKey === 'pi' && 'agent-icon--pi', className)}
      style={maskStyle}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    />
  );
}
