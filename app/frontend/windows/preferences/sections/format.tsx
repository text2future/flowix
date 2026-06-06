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
  DEFAULT_USER_SETTINGS,
} from '../../../constants';
import { Field } from './primitives';

interface FormatSectionProps {
  settings: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
  };
  updateSettings: (updates: Partial<{
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
  }>) => Promise<void>;
}

/**
 * Native range slider styled to match the rest of the Preferences UI.
 * Bound to a numeric setting; updates fire on every change for live preview.
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
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1.5 rounded-full bg-[var(--muted)] appearance-none cursor-pointer accent-[var(--primary)]"
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
      {/* Live preview — label sits as a chip at the top-left inside
          the frame. The font styles are scoped to an inner wrapper so
          the chip itself doesn't resize with the preview controls. */}
      <div className="relative rounded-lg border border-[var(--border)] bg-[var(--memo-detail-bg)]">
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
      <Field
        title="字体 Font"
        description="选择应用整体使用的字体"
      >
        <Select
          value={settings.fontFamily}
          onValueChange={(value) => updateSettings({ fontFamily: value })}
        >
          <SelectTrigger className="w-full justify-between">
            <span style={{ fontFamily: settings.fontFamily }}>{fontLabel}</span>
          </SelectTrigger>
          <SelectContent align="start" className="w-full min-w-[260px]">
            {FONT_FAMILY_OPTIONS.map((font) => (
              <SelectItem key={font.value} value={font.value}>
                <span style={{ fontFamily: font.value }}>{font.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* Font Size */}
      <Field
        title="字号"
        description="拖动调节正文字号 (px)"
      >
        <SliderRow
          value={settings.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          onChange={(v) => updateSettings({ fontSize: v })}
          formatValue={(v) => `${v}px`}
        />
      </Field>

      {/* Line Height */}
      <Field
        title="行间距"
        description="拖动调节正文行高 (倍数)"
      >
        <SliderRow
          value={settings.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={LINE_HEIGHT_STEP}
          onChange={(v) => updateSettings({ lineHeight: v })}
          formatValue={(v) => v.toFixed(2)}
        />
      </Field>

      {/* Reset */}
      <div className="flex justify-start">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-4"
          onClick={() =>
            updateSettings({
              fontFamily: DEFAULT_USER_SETTINGS.fontFamily,
              fontSize: DEFAULT_USER_SETTINGS.fontSize,
              lineHeight: DEFAULT_USER_SETTINGS.lineHeight,
            })
          }
        >
          恢复默认
        </Button>
      </div>
    </div>
  );
}
