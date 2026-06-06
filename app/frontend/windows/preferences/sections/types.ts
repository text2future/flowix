/**
 * Identifier for each settings section.
 *
 * The `account` section is currently only shown in the main-window command
 * palette (popup), not in the dedicated Preferences window — but the type
 * includes it so both surfaces share a single source of truth.
 */
export type SettingsTab =
  | 'account'
  | 'personalize'
  | 'format'
  | 'theme'
  | 'shortcuts'
  | 'connections'
  | 'history'
  | 'agent';
