'use client';

import type { Editor } from '@tiptap/core';
import type { CSSProperties } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  FLOWIX_TEXT_COLORS,
  isFlowixTextColor,
  type FlowixTextColor,
  type FlowixTextMarkAttributes,
  setFlowixTextStyle,
} from '@features/editor/extensions/flowix-text-mark';

import { FlowixBackgroundPalette } from './flowix-background-palette';
import { flowixColorLabelKeys } from './flowix-color-palette';

interface FlowixHighlightPaletteProps {
  editor: Editor;
}

export function FlowixHighlightPalette({
  editor,
}: FlowixHighlightPaletteProps) {
  const { t } = useI18n();
  const attrs = editor.getAttributes('highlight') as FlowixTextMarkAttributes;
  const currentBg = isFlowixTextColor(attrs.flowixBg) ? attrs.flowixBg : null;
  const currentFg = isFlowixTextColor(attrs.flowixFg) ? attrs.flowixFg : null;

  const apply = (patch: { bg?: FlowixTextColor | null; fg?: FlowixTextColor | null }) => {
    setFlowixTextStyle(editor, patch);
  };

  return (
    <div className="editor-highlight-palette">
      <FlowixBackgroundPalette value={currentBg} onChange={bg => apply({ bg })} />
      <div className="editor-highlight-palette__section">
        <div className="editor-highlight-palette__heading">
          <div className="editor-highlight-palette__label">{t('editor.highlight.foreground')}</div>
        </div>
        <div className="editor-highlight-palette__swatches">
          <button
            className="editor-highlight-palette__swatch editor-highlight-palette__swatch--default"
            data-active={currentFg === null}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply({ fg: null })}
            aria-pressed={currentFg === null}
            aria-label={t('editor.highlight.inherit')}
            title={t('editor.highlight.inherit')}
          />
          {FLOWIX_TEXT_COLORS.map((color) => (
            <button
              key={`foreground-${color}`}
              className="editor-highlight-palette__swatch editor-highlight-palette__swatch--foreground"
              data-active={currentFg === color}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply({ fg: currentFg === color ? null : color })}
              style={{ '--flowix-swatch-color': `var(--flowix-text-${color})` } as CSSProperties}
              aria-pressed={currentFg === color}
              aria-label={t(flowixColorLabelKeys[color])}
              title={t(flowixColorLabelKeys[color])}
            >
              <span>A</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
