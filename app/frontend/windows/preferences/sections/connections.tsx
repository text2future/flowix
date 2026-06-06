'use client';

import { Folder } from 'lucide-react';
import { SectionHeader } from './primitives';

const connectionsList = [
  { name: 'Notion', description: 'Knowledge Management', color: '#000000' },
  { name: 'Cursor', description: 'AI Code Editor', color: '#3B82F6' },
  { name: 'Slack', description: 'Team Communication', color: '#4A154B' },
  { name: 'X', description: 'Social Platform', color: '#1DA1F2' },
  { name: 'Reddit', description: 'Community Forum', color: '#FF4500' },
  { name: 'Obsidian', description: 'Bidirectional Notes', color: '#7C3AED' },
];

export function ConnectionsSection() {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Connect Products"
        description="Link external services to import and sync data"
      />
      <div className="grid grid-cols-3 gap-3">
        {connectionsList.map((item, index) => (
          <div
            key={index}
            className="flex flex-col items-center gap-2 p-3 rounded-xl bg-[var(--card)] border border-[var(--border)] hover:border-[var(--primary)] transition-colors cursor-pointer group"
          >
            <Folder className="w-6 h-6 transition-colors" style={{ color: item.color }} />
            <div className="text-sm font-medium text-[var(--foreground)] text-center">
              {item.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
