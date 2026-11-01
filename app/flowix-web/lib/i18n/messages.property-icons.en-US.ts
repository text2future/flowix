import type zhCN from './messages.property-icons.zh-CN';

/**
 * English counterpart of the property-icon message shard. The type annotation
 * keeps its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "document.properties.icon.categories": "Icon categories",
  "document.properties.icon.pack.emoji": "Emoji",
  "document.properties.icon.pack.mochi": "Mochi Stickers",
  "document.properties.icon.category.smileysEmotion": "Faces",
  "document.properties.icon.category.peopleBody": "People",
  "document.properties.icon.category.animalsNature": "Animals",
  "document.properties.icon.category.foodDrink": "Food",
  "document.properties.icon.category.travelPlaces": "Travel",
  "document.properties.icon.category.activities": "Activity",
  "document.properties.icon.category.objects": "Objects",
  "document.properties.icon.category.symbols": "Symbols",
  "document.properties.icon.category.all": "All",
};

export default enUS;
