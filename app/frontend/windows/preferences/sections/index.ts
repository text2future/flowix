// Sections barrel — re-exports every settings tab plus shared types & primitives.
// Both the main-window command palette (`windows/main/menu-board.tsx`) and the
// dedicated Preferences window (`windows/preferences/preferences-view.tsx`)
// import from here so there's a single source of truth for the tab content.
export { AccountSection } from './account';
export { PersonalizeSection } from './personalize';
export { FormatSection } from './format';
export { ThemeSection } from './theme';
export { AgentSection } from './agent';
export { ShortcutsSection } from './shortcuts';
export { ConnectionsSection } from './connections';
export { HistorySection } from './history';

export {
  SectionHeader,
  Field,
  FieldRow,
  FIELD_INPUT_CLASS,
} from './primitives';

export type { SettingsTab } from './types';
