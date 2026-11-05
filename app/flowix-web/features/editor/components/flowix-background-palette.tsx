import type { CSSProperties } from 'react';
import { useI18n } from '@/lib/i18n';
import { FLOWIX_TEXT_COLORS, flowixHighlightBackground, type FlowixTextColor } from '../extensions/flowix-text-colors';
import { flowixColorLabelKeys } from './flowix-color-palette';

interface FlowixBackgroundPaletteProps {
  showLabel?: boolean;
  value: FlowixTextColor | null | 'mixed';
  onChange: (color: FlowixTextColor | null) => void;
}

export function FlowixBackgroundPalette({ value, onChange, showLabel = true }: FlowixBackgroundPaletteProps) {
  const { t } = useI18n();
  return <div className="editor-highlight-palette__section">
    {showLabel && <div className="editor-highlight-palette__heading">
      <div className="editor-highlight-palette__label">{t('editor.highlight.background')}</div>
    </div>}
    <div className="editor-highlight-palette__swatches">
      <button className="editor-highlight-palette__swatch editor-highlight-palette__swatch--default"
        type="button" data-active={value === null} aria-pressed={value === null}
        aria-label={t('editor.highlight.default')} title={t('editor.highlight.default')}
        onMouseDown={event => event.preventDefault()} onClick={() => onChange(null)} />
      {FLOWIX_TEXT_COLORS.map(color => <button key={color}
        className="editor-highlight-palette__swatch editor-highlight-palette__swatch--background"
        type="button" data-active={value === color} aria-pressed={value === color}
        aria-label={t(flowixColorLabelKeys[color])} title={t(flowixColorLabelKeys[color])}
        onMouseDown={event => event.preventDefault()} onClick={() => onChange(value === color ? null : color)}
        style={{ '--flowix-swatch-color': `var(--flowix-text-${color})`, '--flowix-swatch-background': flowixHighlightBackground(color) } as CSSProperties} />)}
    </div>
  </div>;
}
