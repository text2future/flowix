import type { I18nKey } from '@/lib/i18n';
import type {
  PropertyIconCategoryId,
  PropertyIconPackId,
} from '@features/document/properties/property-icons';

/**
 * 分类/图标包 id → 文案 key。
 *
 * 单独放一个模块是因为两个 picker 都要用: React 弹层
 * (icon-picker-panel.tsx) 和正文属性行的原生 DOM 编辑器
 * (frontmatter-property-editor.ts)。写死 Record 而不是拼字符串, 是为了让
 * t() 拿到字面量 key —— I18nKey 是字面量联合类型, 模板字符串过不了类型。
 */
export const PROPERTY_ICON_CATEGORY_LABEL_KEY: Record<PropertyIconCategoryId, I18nKey> = {
  'smileys-emotion': 'document.properties.icon.category.smileysEmotion',
  'people-body': 'document.properties.icon.category.peopleBody',
  'animals-nature': 'document.properties.icon.category.animalsNature',
  'food-drink': 'document.properties.icon.category.foodDrink',
  'travel-places': 'document.properties.icon.category.travelPlaces',
  activities: 'document.properties.icon.category.activities',
  objects: 'document.properties.icon.category.objects',
  symbols: 'document.properties.icon.category.symbols',
  all: 'document.properties.icon.category.all',
};

/** 图标包 id → 文案 key (picker 顶部的包切换)。 */
export const PROPERTY_ICON_PACK_LABEL_KEY: Record<PropertyIconPackId, I18nKey> = {
  emoji: 'document.properties.icon.pack.emoji',
  mochi: 'document.properties.icon.pack.mochi',
};
