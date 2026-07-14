// Sections barrel — re-exports every settings tab plus shared types & primitives.
// Both the main-window command palette (`windows/main/menu-board.tsx`) and the
// dedicated Preferences window (`windows/preferences/preferences-view.tsx`)
// import from here so there's a single source of truth for the tab content.
export { GeneralSection } from '@features/preferences/sections/general';
export { FormatSection } from '@features/preferences/sections/format';
export { ThemeSection } from '@features/preferences/sections/theme';
export { NoteSettingsSection } from '@features/preferences/sections/note-settings';
export { TemplatesSection } from '@features/preferences/sections/templates';
export { DocumentPropertiesSection } from '@features/preferences/sections/document-properties';
export { AgentSection } from '@features/preferences/sections/agent';
export { AgentsSection } from '@features/preferences/sections/agents';
export { QuickPhrasesSection } from '@features/preferences/sections/quick-phrases';
export { ShortcutsSection } from '@features/preferences/sections/shortcuts';
export { CliSection } from '@features/preferences/sections/cli';
export { ConnectionsSection } from '@features/preferences/sections/connections';
export { HistorySection } from '@features/preferences/sections/history';

export {
  SectionHeader,
  Field,
  FieldRow,
  FIELD_INPUT_CLASS,
} from '@features/preferences/sections/primitives';

export type { SettingsTab } from '@features/preferences/sections/types';
