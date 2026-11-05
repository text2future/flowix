import { FONT_FAMILY_OPTIONS, type FontFamilyOption } from '@/lib/constants';
import { createLogger } from '@/lib/logger';
import { fontCache, type CachedFontResult, type FontCacheStatus } from '@platform/tauri/client';

const logger = createLogger('font-cache');

const registeredFontIds = new Set<string>();
const registrationPromises = new Map<string, Promise<boolean>>();

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
    logger.warn('Failed to read font cache status', { error });
    return {};
  }
}

export function ensureDownloadedFontRegistered(fontId: string): Promise<boolean> {
  const pending = registrationPromises.get(fontId);
  if (pending) return pending;
  if (registeredFontIds.has(fontId)) return Promise.resolve(false);

  const registration = ensureAndRegisterFont(fontId).finally(() => {
    registrationPromises.delete(fontId);
  });
  registrationPromises.set(fontId, registration);
  return registration;
}

async function ensureAndRegisterFont(fontId: string): Promise<boolean> {
  const result = await fontCache.ensureCached(fontId);
  await registerCachedFontFaces(result);
  return result.downloaded;
}

async function registerCachedFontFaces(result: CachedFontResult): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  if (registeredFontIds.has(result.fontId)) return;

  const faces: FontFace[] = [];
  try {
    for (const [index, file] of result.files.entries()) {
      const bytes = await fontCache.getCachedBytes(result.fontId, index);
      const face = new FontFace(file.family, bytes, {
        weight: file.weight,
        style: file.style,
      });
      await face.load();
      document.fonts.add(face);
      faces.push(face);
    }
    if (faces.length === 0) throw new Error('No cached font faces were found');
    registeredFontIds.add(result.fontId);
  } catch (error) {
    for (const face of faces) document.fonts.delete(face);
    throw error;
  }
}
