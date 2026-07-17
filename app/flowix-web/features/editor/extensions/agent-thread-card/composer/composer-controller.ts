import { selectAgentThreadCardSendButtonState } from "@features/editor/extensions/agent-thread-card/agent-thread-card-selectors";
import { getPersistableInputDraft } from "@features/editor/extensions/agent-thread-card/composer/composer-draft";
import type { ComposerDraftController } from "@features/editor/extensions/agent-thread-card/composer/composer-draft-controller";
import type { Root } from "react-dom/client";
import { renderAgentThreadCardSendButton } from "@features/editor/extensions/agent-thread-card/composer/send-button-renderer";

export interface ComposerControllerOptions {
  input: HTMLTextAreaElement;
  composer: HTMLElement;
  draft: ComposerDraftController;
  sendButtonRoot: Root;
  inputDraftMaxChars: number;
  getCurrentInputDraft: () => string;
  getUserHistoryMessages: () => string[];
  getSendLabel: (wantStop: boolean) => string;
  getSendButtonWantsStop: () => boolean;
  getHasAttachments: () => boolean;
  getHasPendingAttachments: () => boolean;
  submit: () => void;
  stop: () => void;
}

export class ComposerController {
  private readonly input: HTMLTextAreaElement;
  private readonly composer: HTMLElement;
  private readonly draft: ComposerDraftController;
  private readonly sendButtonRoot: Root;
  private readonly inputDraftMaxChars: number;
  private readonly getCurrentInputDraft: () => string;
  private readonly getUserHistoryMessages: () => string[];
  private readonly getSendLabel: (wantStop: boolean) => string;
  private readonly getSendButtonWantsStop: () => boolean;
  private readonly getHasAttachments: () => boolean;
  private readonly getHasPendingAttachments: () => boolean;
  private readonly submit: () => void;
  private readonly stop: () => void;

  private isComposing = false;
  private historyCursor: number | null = null;
  private preNavDraft: string | null = null;
  private disposed = false;

  constructor(options: ComposerControllerOptions) {
    this.input = options.input;
    this.composer = options.composer;
    this.draft = options.draft;
    this.sendButtonRoot = options.sendButtonRoot;
    this.inputDraftMaxChars = options.inputDraftMaxChars;
    this.getCurrentInputDraft = options.getCurrentInputDraft;
    this.getUserHistoryMessages = options.getUserHistoryMessages;
    this.getSendLabel = options.getSendLabel;
    this.getSendButtonWantsStop = options.getSendButtonWantsStop;
    this.getHasAttachments = options.getHasAttachments;
    this.getHasPendingAttachments = options.getHasPendingAttachments;
    this.submit = options.submit;
    this.stop = options.stop;

    this.input.addEventListener("keydown", this.handleKeydown);
    this.input.addEventListener("compositionstart", this.handleCompositionStart);
    this.input.addEventListener("compositionend", this.handleCompositionEnd);
    this.input.addEventListener("input", this.handleInput);
    this.input.addEventListener("blur", this.handleBlur);
  }

  persistInputDraft(value: string): void {
    const { nextDraft, oversizedDomValue } = getPersistableInputDraft(
      value,
      this.inputDraftMaxChars,
    );
    this.draft.setOversizedValue(oversizedDomValue);
    if (nextDraft === this.getCurrentInputDraft()) return;
    this.draft.schedule(nextDraft);
  }

  flushPendingDraft(): void {
    this.draft.flush();
  }

  clearDraft(): void {
    this.draft.clear();
  }

  resetHistoryNavigation(): void {
    this.historyCursor = null;
    this.preNavDraft = null;
  }

  setHistoryValue(
    content: string,
    options: { persistDraft?: boolean } = {},
  ): void {
    this.input.value = content;
    this.input.setSelectionRange(content.length, content.length);
    if (options.persistDraft) {
      this.persistInputDraft(content);
    }
    this.updateMultiLineState();
  }

  updateMultiLineState(): void {
    if (this.input.value === "") {
      this.composer.classList.remove("agent-thread-card__composer--multi-line");
      this.setSendButtonState("");
      return;
    }

    const isMulti = this.input.scrollHeight > 30;
    this.composer.classList.toggle(
      "agent-thread-card__composer--multi-line",
      isMulti,
    );
    this.setSendButtonState(this.input.value.trim());
  }

  setSendButtonState(inputValue: string = this.input.value.trim()): void {
    if (this.disposed) return;
    const { wantStop, disabled } = selectAgentThreadCardSendButtonState({
      wantStop: this.getSendButtonWantsStop(),
      inputValue,
      hasAttachments: this.getHasAttachments(),
      hasPendingAttachments: this.getHasPendingAttachments(),
    });
    renderAgentThreadCardSendButton({
      root: this.sendButtonRoot,
      label: this.getSendLabel(wantStop),
      wantStop,
      disabled,
      onStop: this.stop,
      onSubmit: this.submit,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeEventListener("keydown", this.handleKeydown);
    this.input.removeEventListener(
      "compositionstart",
      this.handleCompositionStart,
    );
    this.input.removeEventListener("compositionend", this.handleCompositionEnd);
    this.input.removeEventListener("input", this.handleInput);
    this.input.removeEventListener("blur", this.handleBlur);
    this.sendButtonRoot.unmount();
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.isComposing || event.isComposing || event.keyCode === 229) return;

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
        return;
      if (!this.shouldHandleHistoryKey(event.key)) return;
      event.preventDefault();
      this.navigateHistory(event.key === "ArrowUp" ? "up" : "down");
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    this.submit();
  };

  private readonly handleCompositionStart = (): void => {
    this.isComposing = true;
  };

  private readonly handleCompositionEnd = (): void => {
    this.isComposing = false;
  };

  private readonly handleInput = (): void => {
    if (!this.isCurrentHistoryEntryUnmodified()) {
      this.resetHistoryNavigation();
    }
    this.persistInputDraft(this.input.value);
    this.updateMultiLineState();
  };

  private readonly handleBlur = (): void => {
    this.flushPendingDraft();
  };

  private shouldHandleHistoryKey(key: string): boolean {
    const direction = key === "ArrowUp" ? "up" : "down";
    if (this.getUserHistoryMessages().length === 0) return false;
    if (!this.isCaretCollapsed()) return false;

    if (direction === "up") {
      return this.isCaretOnFirstLine();
    }

    if (this.historyCursor === null) return false;
    return this.isCaretOnLastLine();
  }

  private isCaretCollapsed(): boolean {
    return this.input.selectionStart === this.input.selectionEnd;
  }

  private isCaretOnFirstLine(): boolean {
    const cursor = this.input.selectionStart ?? 0;
    return this.input.value.lastIndexOf("\n", Math.max(0, cursor - 1)) === -1;
  }

  private isCaretOnLastLine(): boolean {
    const cursor = this.input.selectionEnd ?? 0;
    return this.input.value.indexOf("\n", cursor) === -1;
  }

  private isCurrentHistoryEntryUnmodified(): boolean {
    if (this.historyCursor === null) return false;
    const messages = this.getUserHistoryMessages();
    return messages[this.historyCursor] === this.input.value;
  }

  private navigateHistory(direction: "up" | "down"): void {
    const messages = this.getUserHistoryMessages();
    if (messages.length === 0) return;

    if (direction === "up") {
      if (this.historyCursor === null && this.preNavDraft === null) {
        this.preNavDraft = this.input.value;
      }
      const next =
        this.historyCursor === null
          ? messages.length - 1
          : Math.max(0, this.historyCursor - 1);
      this.historyCursor = next;
      this.setHistoryValue(messages[next]);
      return;
    }

    if (this.historyCursor === null) return;
    const next = this.historyCursor + 1;
    if (next >= messages.length) {
      this.historyCursor = null;
      const draft = this.preNavDraft ?? "";
      this.setHistoryValue(draft, { persistDraft: true });
      return;
    }
    this.historyCursor = next;
    this.setHistoryValue(messages[next]);
  }
}
