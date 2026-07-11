import { flushSync } from "react-dom";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { Tooltip } from "@shared/ui/tooltip";
import { ICON_STOP_PATH } from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";

export interface AgentThreadCardSendButtonRenderOptions {
  root: Root;
  label: string;
  wantStop: boolean;
  disabled: boolean;
  onStop: () => void;
  onSubmit: () => void;
}

export function renderAgentThreadCardSendButton(
  options: AgentThreadCardSendButtonRenderOptions,
): void {
  const className = options.wantStop
    ? "agent-thread-card__send agent-thread-card__send--stop"
    : "agent-thread-card__send";

  flushSync(() => {
    options.root.render(
      <Tooltip content={options.label}>
        <button
          type="button"
          className={className}
          disabled={options.disabled}
          aria-label={options.label}
          onClick={() => {
            if (options.wantStop) {
              options.onStop();
              return;
            }
            options.onSubmit();
          }}
        >
          {options.wantStop ? <StopIcon /> : <SendIcon />}
        </button>
      </Tooltip>,
    );
  });
}

function StopIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="agent-thread-card__send-icon"
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
      className="agent-thread-card__send-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
