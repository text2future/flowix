// Sections barrel for direct consumers that need specific settings sections.
// The Preferences window uses the lazy tab registry instead, so importing the
// barrel here would pull every section into the preference-window entry chunk.
export { GeneralSection } from '@features/preferences/sections/general';
export { EnvironmentConfigSection } from '@features/preferences/sections/environment-config';
export { FormatSection } from '@features/preferences/sections/format';
export { ThemeSection } from '@features/preferences/sections/theme';
export { TemplatesSection } from '@features/preferences/sections/templates';
export { DocumentPropertiesSection } from '@features/preferences/sections/document-properties';
export { AgentSection } from '@features/preferences/sections/agent';
export { AgentsSection } from '@features/preferences/sections/agents';
export { DshSettingsSection } from '@features/preferences/sections/dsh';
export { PiSettingsSection } from '@features/preferences/sections/pi';
export { ShortcutsSection } from '@features/preferences/sections/shortcuts';
export { CliSection } from '@features/preferences/sections/cli';
export { McpSection } from '@features/preferences/sections/mcp';
export { ConnectionsSection } from '@features/preferences/sections/connections';
export { CloudSyncSection } from '@features/preferences/sections/cloud-sync';
export { HistorySection } from '@features/preferences/sections/history';
export { PluginsSection } from '@features/preferences/sections/plugins';

export {
  SectionHeader,
  Field,
  FieldRow,
  FIELD_INPUT_CLASS,
} from '@features/preferences/sections/primitives';

export type { SettingsTab } from '@features/preferences/sections/types';
