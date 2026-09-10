export const PLUGIN_ARTIFACT_RENDERER_IDS = [
  'markmap',
  'html',
  'webpage',
  'json-viewer',
  'markdown',
  'text',
] as const;

export type PluginArtifactRendererId = typeof PLUGIN_ARTIFACT_RENDERER_IDS[number];

const rendererIds = new Set<string>(PLUGIN_ARTIFACT_RENDERER_IDS);

export function isPluginArtifactRendererId(value: string): value is PluginArtifactRendererId {
  return rendererIds.has(value);
}
