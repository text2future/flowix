'use client';

import { SectionHeader } from './primitives';

const shortcutsList = [
  { keys: ['⌘', 'K'], label: 'Quick Search' },
  { keys: ['⌘', 'N'], label: 'New Document' },
  { keys: ['⌘', 'Shift', 'N'], label: 'New Folder' },
  { keys: ['⌘', '/'], label: 'View Shortcuts' },
  { keys: ['⌘', 'S'], label: 'Save Document' },
  { keys: ['⌘', 'B'], label: 'Toggle Sidebar' },
];

export function ShortcutsSection() {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Keyboard Shortcuts"
        description="All the keybindings available across the app"
      />
      <div className="space-y-2">
        {shortcutsList.map((shortcut, index) => (
          <div
            key={index}
            className="flex items-center justify-between p-3 rounded-lg bg-[var(--card)] hover:bg-[var(--muted)] transition-colors"
          >
            <span className="text-sm text-[var(--foreground)]">{shortcut.label}</span>
            <div className="flex items-center gap-1">
              {shortcut.keys.map((key, i) => (
                <kbd
                  key={i}
                  className="px-2 py-1 text-xs font-mono bg-[var(--muted)] text-[var(--muted-foreground)] rounded border border-[var(--border)]"
                >
                  {key}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
