export {
  APP_LANGUAGES,
  DEFAULT_APP_LANGUAGE,
  LANGUAGE_OPTIONS,
  messages,
  sanitizeAppLanguage,
  type AppLanguage,
  type I18nKey,
} from '@features/i18n/locales';
export { I18nProvider, translate, useI18n, type I18nParams } from '@features/i18n/provider';
export { detectSystemLanguage } from '@features/i18n/detect';
export {
  useRegionStore,
  getCurrentRegion,
  isMainlandChina,
  sanitizeRegion,
  detectRegion,
  type Region,
} from '@features/i18n/region-store';
