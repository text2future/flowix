# Flowix 多语言方案

## 目标

Flowix 的 UI 语言需要独立于 Agent 回复语言。`personalize.preferredLanguage` 继续只表示 AI 回复偏好；新增顶层 `settings.language` 作为应用显示语言，当前支持：

- `zh-CN`: 简体中文，默认语言
- `en-US`: English

## 当前落地

- 前端新增 `app/flowix-web/features/i18n`：
  - `locales.ts`: 语言枚举、翻译字典、语言 sanitize。
  - `provider.tsx`: `I18nProvider`、`useI18n()`、`translate()`。
  - `index.ts`: 模块出口。
- `App.tsx` 在主题、tooltip、快捷键 provider 外层接入 `I18nProvider`，并同步设置 `document.documentElement.lang`。
- 偏好设置新增“界面语言”，读写 `settings.language`，沿用现有偏好设置落盘、debounce、跨窗口同步。
- Rust 后端 `PreferenceFile` 增加 `language` 字段，兼容老的 `preference.json` 缺字段场景。
- 已迁移核心可见 UI：
  - 偏好窗口侧栏、通用、排版、主题。
  - 应用内菜单面板复用的通用设置。
  - Windows 标题栏按钮。
  - 底部状态栏和笔记本切换器。
  - 笔记本删除确认弹窗。
  - 编辑器默认 placeholder、块拖拽菜单、表格浮动工具栏。

## 设计约定

1. 新 UI 文案必须先加翻译 key，再通过 `useI18n().t(key)` 使用。
2. 非 React 代码需要翻译时使用 `translate(language, key)`，不要直接读 `messages`。
3. 用户内容、Markdown 文档内容、后端日志、开发注释不做 UI 翻译。
4. 持久化值和显示文案分离。例如 response length 仍兼容旧值 `简洁/标准/详细`，但显示文本走翻译。
5. 语言新增流程：
   - 在 `APP_LANGUAGES` 增加语言码。
   - 给 `messages` 补齐所有 key。
   - 在 `LANGUAGE_OPTIONS` 增加选项。
   - 运行 `npm.cmd run build` 和 `cargo check`。

## 后续迁移优先级

1. Agent 面板、输入框、欢迎页、工具消息。
2. Memo 列表、搜索、筛选、排序、新建/删除笔记弹窗。
3. 快捷键设置页、连接应用、历史页、Agent 配置页。
4. Toast 和错误提示的剩余散点。
5. `rg -n "[\\u4e00-\\u9fff]" app/flowix-web -g "*.tsx" -g "*.ts"` 定期扫尾。

## 已验证

- `npm.cmd run build`
- `cargo check`
