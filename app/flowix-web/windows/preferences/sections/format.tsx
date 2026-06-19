'use client';

import { Button } from '../../../components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '../../../components/ui/select';
import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_STEP,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_STEP,
  DOCUMENT_WIDTH_MIN,
  DOCUMENT_WIDTH_MAX,
  DOCUMENT_WIDTH_STEP,
  DEFAULT_USER_SETTINGS,
} from '../../../lib/constants';
import { FieldRow, SectionHeader } from './primitives';

interface FormatSectionProps {
  settings: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    documentWidth: number;
  };
  updateSettings: (updates: {
    format?: Partial<{
      fontFamily: string;
      fontSize: number;
      lineHeight: number;
      documentWidth: number;
    }>;
  }) => Promise<void>;
}

/**
 * Native range slider styled to match the rest of the Preferences UI.
 *
 * Track is a single linear-gradient: filled (--primary) up to the
 * current value, then a darker neutral (#cbd5e1) for the unfilled
 * remainder. Bound to a numeric setting; updates fire on every change
 * for live preview. Used inside a FieldRow; container is fixed-width
 * so the slider doesn't stretch across the full preferences content area.
 */
function SliderRow({
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
}) {
  const display = formatValue ? formatValue(value) : String(value);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="flex w-64 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--primary)]"
        style={{
          background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${percent}%, #cbd5e1 ${percent}%, #cbd5e1 100%)`,
        }}
      />
      <span className="w-12 text-right text-sm tabular-nums text-[var(--muted-foreground)]">
        {display}
      </span>
    </div>
  );
}

export function FormatSection({ settings, updateSettings }: FormatSectionProps) {
  // Find the label for the currently active font; fall back to its raw stack
  // so a previously-saved unknown font still surfaces in the trigger.
  const currentFont = FONT_FAMILY_OPTIONS.find((f) => f.value === settings.fontFamily);
  const fontLabel = currentFont?.label ?? settings.fontFamily;
  return (
    <div className="space-y-6 pb-16">
      <SectionHeader
        title="排版"
      />

      {/* Live preview — label sits as a chip at the top-left inside
          the frame. The font styles are scoped to an inner wrapper so
          the chip itself doesn't resize with the preview controls. */}
      <div className="relative rounded-lg border border-[var(--border)] bg-[var(--document-bg)]">
        <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] font-medium leading-none bg-[var(--muted)] text-[var(--muted-foreground)] rounded select-none">
          预览
        </span>
        <div
          className="p-4 pt-7 text-[var(--foreground)]"
          style={{
            fontFamily: settings.fontFamily,
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
          }}
        >
          <p className="m-0">
            The quick brown fox jumps over the lazy dog.
          </p>
          <p className="m-0 mt-2">
            敏捷的棕色狐狸跨越了那只懒惰的狗。
          </p>
        </div>
      </div>

      {/* Font Family */}
      <FieldRow
        title="字体"
        description="选择应用整体使用的字体"
      >
        <Select
          value={settings.fontFamily}
          onValueChange={(value) => updateSettings({ format: { fontFamily: value } })}
        >
          <SelectTrigger className="w-48">
            <span
              className="flex-1 text-left"
              style={{ fontFamily: settings.fontFamily }}
            >
              {fontLabel}
            </span>
          </SelectTrigger>
          <SelectContent align="end" className="w-48">
            {FONT_FAMILY_OPTIONS.map((font) => (
              <SelectItem key={font.value} value={font.value}>
                <span style={{ fontFamily: font.value }}>{font.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      {/* Document Width — 放在字号上方, 让用户先决定"页面多宽"再决定"字多大" */}
      <FieldRow
        title="文档宽度"
        description="拖动调节文档编辑区的最大宽度 (px)"
      >
        <SliderRow
          value={settings.documentWidth}
          min={DOCUMENT_WIDTH_MIN}
          max={DOCUMENT_WIDTH_MAX}
          step={DOCUMENT_WIDTH_STEP}
          onChange={(v) => updateSettings({ format: { documentWidth: v } })}
          formatValue={(v) => `${v}px`}
        />
      </FieldRow>

      {/* Font Size */}
      <FieldRow
        title="字号"
        description="拖动调节正文字号 (px)"
      >
        <SliderRow
          value={settings.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          onChange={(v) => updateSettings({ format: { fontSize: v } })}
          formatValue={(v) => `${v}px`}
        />
      </FieldRow>

      {/* Line Height */}
      <FieldRow
        title="行间距"
        description="拖动调节正文行高 (倍数)"
      >
        <SliderRow
          value={settings.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={LINE_HEIGHT_STEP}
          onChange={(v) => updateSettings({ format: { lineHeight: v } })}
          formatValue={(v) => v.toFixed(2)}
        />
      </FieldRow>

      {/* Reset */}
      <div className="flex justify-start">
        <Button
          variant="outline"
          className="px-3"
          onClick={() =>
            updateSettings({
              format: {
                fontFamily: DEFAULT_USER_SETTINGS.format.fontFamily,
                fontSize: DEFAULT_USER_SETTINGS.format.fontSize,
                lineHeight: DEFAULT_USER_SETTINGS.format.lineHeight,
                documentWidth: DEFAULT_USER_SETTINGS.format.documentWidth,
              },
            })
          }
        >
          恢复默认
        </Button>
      </div>
    </div>
  );
}
