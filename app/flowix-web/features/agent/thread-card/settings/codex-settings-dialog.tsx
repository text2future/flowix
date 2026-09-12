import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { X } from "lucide-react";
import { CodexSettingsSection } from "@features/preferences/sections/codex";

function CodexSettingsDialog({ notebookPath, onClose }: { notebookPath: string; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return open ? (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-2" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div role="dialog" aria-modal="true" aria-label="Codex 配置" className="relative flex h-[80vh] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl bg-[var(--background)] shadow-2xl">
        <button type="button" aria-label="关闭" className="absolute right-5 top-5 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--divider)] bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]" onClick={close}>
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto p-6 [scrollbar-gutter:stable]">
          <div className="mb-10 w-full">
            <CodexSettingsSection notebookPath={notebookPath} />
          </div>
        </div>
      </div>
    </div>
  ) : null;
}

export class CodexSettingsDialogController {
  private container: HTMLDivElement | null = null;
  private root: Root | null = null;

  open(notebookPath: string): void {
    this.close();
    const container = document.createElement("div");
    container.dataset.codexSettingsDialog = "true";
    document.body.append(container);
    this.container = container;
    this.root = createRoot(container);
    this.root.render(<CodexSettingsDialog notebookPath={notebookPath} onClose={() => this.close()} />);
  }

  close(): void {
    this.root?.unmount();
    this.root = null;
    this.container?.remove();
    this.container = null;
  }
}
