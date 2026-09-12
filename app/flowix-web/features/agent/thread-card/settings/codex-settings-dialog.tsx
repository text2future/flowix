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
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="codex-settings-dialog-title" className="relative max-h-[92vh] w-full max-w-[900px] overflow-y-auto rounded-2xl bg-[var(--background)] p-6 shadow-2xl">
        <button type="button" aria-label="关闭" className="absolute right-4 top-4 rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" onClick={close}>
          <X className="h-4 w-4" />
        </button>
        <div id="codex-settings-dialog-title" className="sr-only">Codex 设置</div>
        <CodexSettingsSection notebookPath={notebookPath} />
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
