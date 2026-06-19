import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip } from "./ui/tooltip";

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function isTauriApp(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

export function WindowsTitlebarControls() {
  if (!isWindowsPlatform() || !isTauriApp()) return null;

  return (
    <div className="fixed top-0 right-0 z-[1001] flex h-9 select-none bg-[var(--bg-titlebar)] pointer-events-auto [-webkit-app-region:no-drag]">
      <Tooltip content="最小化" side="bottom">
        <button
          type="button"
          aria-label="最小化"
          onClick={() => getCurrentWindow().minimize()}
          className="flex h-9 w-[42px] items-center justify-center text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] [-webkit-app-region:no-drag]"
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip content="最大化" side="bottom">
        <button
          type="button"
          aria-label="最大化"
          onClick={() => getCurrentWindow().toggleMaximize()}
          className="flex h-9 w-[42px] items-center justify-center text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] [-webkit-app-region:no-drag]"
        >
          <Square className="h-3 w-3" strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip content="关闭" side="bottom">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => getCurrentWindow().close()}
          className="flex h-9 w-[42px] items-center justify-center text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)] hover:text-[var(--floating-foreground)] [-webkit-app-region:no-drag]"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </Tooltip>
    </div>
  );
}
