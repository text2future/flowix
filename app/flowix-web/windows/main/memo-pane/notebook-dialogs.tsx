'use client';

import { Input } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import type { Notebook } from '../../../lib/store';

interface NotebookDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  newNotebookName: string;
  onNewNotebookNameChange: (name: string) => void;
  newNotebookPath: string;
  onNewNotebookPathChange: (path: string) => void;
  onSelectDirectory: () => Promise<void>;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  editingNotebook: Notebook | null;
  editNotebookName: string;
  onEditNotebookNameChange: (name: string) => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
}

export function NotebookDialogs({
  createOpen,
  onCreateOpenChange,
  newNotebookName,
  onNewNotebookNameChange,
  newNotebookPath,
  onNewNotebookPathChange,
  onSelectDirectory,
  onConfirmCreate,
  onCancelCreate,
  editOpen,
  onEditOpenChange,
  editingNotebook,
  editNotebookName,
  onEditNotebookNameChange,
  onConfirmEdit,
  onCancelEdit,
}: NotebookDialogsProps) {
  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            <DialogTitle>新建笔记本</DialogTitle>
          </DialogHeader>
          <div className="mt-1 space-y-3">
            <Input
              placeholder="笔记本名称"
              value={newNotebookName}
              onChange={(event) => onNewNotebookNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onConfirmCreate();
              }}
              autoFocus
            />
            <div className="flex gap-2">
              <Input
                placeholder="选择本地文件夹"
                value={newNotebookPath}
                onChange={(event) => onNewNotebookPathChange(event.target.value)}
                className="flex-1"
                readOnly
              />
              <Button
                variant="outline"
                className="h-8"
                onClick={() => {
                  void onSelectDirectory();
                }}
              >
                选择
              </Button>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelCreate}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirmCreate}
              className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
              disabled={!newNotebookName.trim() || !newNotebookPath.trim()}
            >
              创建
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            <DialogTitle>编辑笔记本</DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <Input
              placeholder="笔记本名称"
              value={editNotebookName}
              onChange={(event) => onEditNotebookNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onConfirmEdit();
              }}
              autoFocus
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelEdit}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirmEdit}
              className="h-8 px-3 text-sm rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
              disabled={!editNotebookName.trim() || editNotebookName.trim() === editingNotebook?.name}
            >
              保存
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
