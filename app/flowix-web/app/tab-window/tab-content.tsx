import type { ComponentProps } from 'react';
import type { WindowTab } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';

interface TabContentProps {
  tab: WindowTab;
  contentKey: string;
  memoContentProps: Omit<ComponentProps<typeof DocumentContainer>, 'memoId' | 'filePath' | 'notebookId' | 'notebookPath'> & {
    filePath: string;
    notebookId: string | null;
    notebookPath: string | null;
  };
}

export function TabContent({ tab, contentKey, memoContentProps }: TabContentProps) {
  if (tab.target.kind === 'web') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
        {tab.target.url}
      </div>
    );
  }

  return (
    <DocumentContainer
      key={contentKey}
      {...memoContentProps}
      filePath={memoContentProps.filePath}
      memoId={tab.target.memoId}
      notebookId={memoContentProps.notebookId ?? tab.target.notebookId}
      notebookPath={memoContentProps.notebookPath ?? tab.target.notebookPath}
    />
  );
}
