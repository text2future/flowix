'use client';

import { History } from 'lucide-react';
import { SectionHeader } from './primitives';

export function HistorySection() {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="History"
        description="Recent actions and conversation history"
      />
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <History className="w-12 h-12 text-[var(--muted-foreground)] mb-4" />
        <p className="text-sm text-[var(--muted-foreground)]">No history yet</p>
      </div>
    </div>
  );
}
