import { FONT_FAMILY_OPTIONS, type FontFamilyOption } from '@/lib/constants';
import { fontCache, type CachedFontResult, type FontCacheStatus } from '@platform/tauri/client';

const STYLE_ID = 'flowix-downloaded-fonts';

export function getFontOptionById(fontId: string | undefined): FontFamilyOption | undefined {
  if (!fontId) return undefined;
  return FONT_FAMILY_OPTIONS.find((font) => font.id === fontId);
}

export function getFontOptionByValue(fontFamily: string): FontFamilyOption | undefined {
  return FONT_FAMILY_OPTIONS.find((font) => font.value === fontFamily);
}

export function isDownloadableFont(font: FontFamilyOption | undefined): boolean {
  return font?.source === 'downloadable';
}

export async function getDownloadedFontStatus(): Promise<Record<string, boolean>> {
  try {
    const statuses = await fontCache.getStatus();
    return statuses.reduce<Record<string, boolean>>((acc, status: FontCacheStatus) => {
      acc[status.fontId] = status.cached;
      return acc;
    }, {});
  } catch (error) {
    console.warn('Failed to read font cache status:', error);
    return {};
  }
}

export async function ensureDownloadedFontRegistered(fontId: string): Promise<void> {
  const result = await fontCache.ensureCached(fontId);
  registerDownloadedFontFaces(result);
}

function registerDownloadedFontFaces(result: CachedFontResult): void {
  if (typeof document === 'undefined' || result.files.length === 0) return;
  const styleId = `${STYLE_ID}-${result.fontId}`;
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = result.files.map((file) => {
    const src = fontCache.toAssetUrl(file.path);
    const unicodeRange = file.unicodeRange ? `\n  unicode-range: ${file.unicodeRange};` : '';
    return `@font-face {
  font-family: '${escapeCssString(file.family)}';
  font-style: ${file.style};
  font-weight: ${file.weight};
  font-display: swap;
  src: url('${src}') format('${escapeCssString(file.format)}');${unicodeRange}
}`;
  }).join('\n\n');
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
