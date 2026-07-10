/**
 * Identifier for each settings section.
 *
 * 模型配置 (供应商 / 模型 / API Key) 现在塞在 `aiAgent` 的 Flowix 卡片
 * 里, 不再是独立 tab。
 *
 * `imageGeneration` / `videoGeneration` / `agent` / `modelConfig` /
 * `agents` 都是历史 id, 现在仅作 normalizeInitialTab 的 URL 迁移兜底
 * 使用, 不再挂在新 tab 列表里。 图片生成 + 视频生成合并到 `tools`。
 */
export type SettingsTab =
  | 'general'
  | 'format'
  | 'theme'
  | 'noteSettings'
  | 'shortcuts'
  | 'cli'
  | 'connections'
  | 'tools'
  | 'history'
  | 'aiAgent'
  // 旧 id, 仍在 normalizeInitialTab 里重定向使用。
  | 'agent'
  | 'agents'
  | 'modelConfig'
  | 'imageGeneration'
  | 'videoGeneration';
