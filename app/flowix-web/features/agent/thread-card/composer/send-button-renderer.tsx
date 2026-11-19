import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { Tooltip } from "@shared/ui/tooltip";
import { ICON_STOP_PATH } from "@features/agent/thread-card/agent-thread-card-icons";

export interface AgentThreadCardSendButtonRenderOptions {
  root: Root;
  label: string;
  wantStop: boolean;
  isRunning?: boolean;
  disabled: boolean;
  onStop: () => void;
  onSubmit: () => void;
}

export function renderAgentThreadCardSendButton(
  options: AgentThreadCardSendButtonRenderOptions,
): void {
  // 不要套 flushSync ── setSendButtonState 可能从 ProseMirror 的 update /
  // React 的 commit phase 被调到, 此时 React 已在渲染, flushSync 会触发
  // "flushSync was called from inside a lifecycle method" 报错。root.render
  // 只负责调度更新, DOM 提交可能发生在随后的事件循环。
  const className = [
    "agent-composer__send",
    options.wantStop && "agent-composer__send--stop",
    options.isRunning && "agent-composer__send--running",
  ].filter(Boolean).join(" ");

  options.root.render(
    <Tooltip content={options.label}>
      <button
        type="button"
        className={className}
        disabled={options.disabled}
        aria-busy={options.isRunning || undefined}
        aria-label={options.label}
        onClick={() => {
          if (options.wantStop) {
            options.onStop();
            return;
          }
          options.onSubmit();
        }}
      >
        {options.isRunning ? (
          <span className="agent-composer__send-spinner flowix-spin" aria-hidden="true" />
        ) : options.wantStop ? (
          <StopIcon />
        ) : (
          <SendIcon />
        )}
      </button>
    </Tooltip>,
  );
}

function StopIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="agent-composer__send-icon"
      viewBox="0 0 256 256"
    >
      <path d={ICON_STOP_PATH} fill="currentColor" />
    </svg>
  );
}

function SendIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="agent-composer__send-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}
