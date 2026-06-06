// All hooks live here, regardless of which window consumes them. The only
// organising principle is the consumer count: truly cross-window hooks
// (settings/theme/font) sit alongside the rest; the "main-only" ones
// (`useTauriRpc`, `useMemoInsertAnimation`) live here too because the
// alternative — mirroring the windows/ folder structure under hooks/ —
// trades clarity for a separation that adds no value.
export { useTauriRpc } from './useTauriRpc';
export { useUserSettings } from './useUserSettings';
export { useApplyTheme } from './useApplyTheme';
export { useApplyFontSettings } from './useApplyFontSettings';
export { useMemoInsertAnimation } from './useMemoInsertAnimation';
