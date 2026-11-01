/**
 * 属性图标 picker 的分片文案。
 *
 * 主表 (messages.zh-CN / messages.en-US) 被千行闸门冻结, 新增文案放分片。
 * 这里只放「图标分类」相关的 key —— 分类 id 与文案 key 的映射在
 * features/document/properties/icon-category-labels.ts。
 *
 * 分类标签刻意用短词: picker 只有 280px 宽, 分类条一行要放得下 8 个。
 */
const zhCN = {
  "document.properties.icon.categories": "图标分类",
  "document.properties.icon.pack.emoji": "Emoji",
  "document.properties.icon.pack.mochi": "Mochi 贴纸",
  "document.properties.icon.category.smileysEmotion": "表情",
  "document.properties.icon.category.peopleBody": "人物",
  "document.properties.icon.category.animalsNature": "动物",
  "document.properties.icon.category.foodDrink": "食物",
  "document.properties.icon.category.travelPlaces": "旅行",
  "document.properties.icon.category.activities": "活动",
  "document.properties.icon.category.objects": "物品",
  "document.properties.icon.category.symbols": "符号",
  "document.properties.icon.category.all": "全部",
};

export default zhCN;
