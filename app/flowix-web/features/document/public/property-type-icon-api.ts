/**
 * 属性「类型图标」的公共入口 ── 只导出 `createPropertySvgIcon`，
 * 避免调用方（如集合文件树表头）为了一个 18px 图标去 import 整个属性面板。
 *
 * 图标本体是 DOM 元素（`createPropertySvgIcon` 用 createElementNS 生成，
 * 需要把它塞进宿主元素），所以这里不再包 React 组件。
 */
export { createPropertySvgIcon } from '@features/document/properties/property-type-icon';
