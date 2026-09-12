import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { Markdown } from "@tiptap/markdown";
import { pushHandler } from "@/lib/shortcuts/handler-registry";

import { selectAgentThreadCardSendButtonState } from "@features/agent/thread-card/agent-thread-card-selectors";
import { getPersistableInputDraft } from "@features/agent/thread-card/composer/composer-draft";
import type { ComposerDraftController } from "@features/agent/thread-card/composer/composer-draft-controller";
import { renderAgentThreadCardSendButton } from "@features/agent/thread-card/composer/send-button-renderer";
import { ComposerSlashCommandController } from "@features/agent/thread-card/composer/composer-slash-command-controller";
import {
  ComposerSlashToken,
  composerSlashMarkdownToPrompt,
} from "@features/agent/thread-card/composer/composer-slash-token";
import {
  ComposerSkillToken,
  composerSkillMarkdownToPrompt,
} from "@features/agent/thread-card/composer/composer-skill-token";
import type {
  ComposerSlashCommand,
  ComposerSlashSkill,
} from "@features/agent/thread-card/composer/composer-slash-command-controller";
import type { AgentTypeKey } from "@/types/agent";
import { NoteReference } from "@features/editor/extensions/note-link";
import type { MemoRef } from "@features/agent/thread-card/role/agent-role-picker-controller";
import type { Root } from "react-dom/client";

// Chromium/WebKit can expose modified cursor-navigation keys as a text input
// containing an ASCII control character (for example Ctrl+Right may arrive as
// U+001C in a Tauri WebView). These characters are never useful in an agent
// prompt and otherwise become real ProseMirror text nodes.
const composerControlCharacterPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const composerControlCharacterGlobalPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function removeComposerControlCharacters(value: string): string {
  return value.replace(composerControlCharacterGlobalPattern, "");
}

export interface ComposerControllerOptions {
  input: HTMLDivElement;
  composer: HTMLElement;
  initialDraft: string;
  draft: ComposerDraftController;
  sendButtonRoot: Root;
  inputDraftMaxChars: number;
  getCurrentInputDraft: () => string;
  getUserHistoryMessages: () => string[];
  getSendLabel: (wantStop: boolean, isRunning?: boolean) => string;
  getSendButtonWantsStop: () => boolean;
  getSendButtonRunning?: () => boolean;
  getHasAttachments: () => boolean;
  getHasPendingAttachments: () => boolean;
  agentType?: AgentTypeKey;
  listDshSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  listCodexSkills?: () => Promise<readonly ComposerSlashSkill[]>;
  onModelSelect?: () => void;
  onPermissionSelect?: () => void;
  onDirectCommand?: (command: ComposerSlashCommand) => void;
  submit: () => void;
  stop: () => void;
}

/** Rich text composer shared by the embedded card and standalone detail. */
export class ComposerController {
  private readonly input: HTMLDivElement;
  private readonly composer: HTMLElement;
  private readonly editor: Editor;
  private readonly draft: ComposerDraftController;
  private readonly sendButtonRoot: Root;
  private readonly inputDraftMaxChars: number;
  private readonly getCurrentInputDraft: () => string;
  private readonly getUserHistoryMessages: () => string[];
  private readonly getSendLabel: (wantStop: boolean, isRunning?: boolean) => string;
  private readonly getSendButtonWantsStop: () => boolean;
  private readonly getSendButtonRunning: () => boolean;
  private readonly getHasAttachments: () => boolean;
  private readonly getHasPendingAttachments: () => boolean;
  private readonly submit: () => void;
  private readonly stop: () => void;
  private readonly slashCommands: ComposerSlashCommandController;
  private readonly removeSelectAllHandler: () => void;

  private isComposing = false;
  private historyCursor: number | null = null;
  private preNavDraft: string | null = null;
  private disposed = false;
  private suppressUpdates = true;
  private scrollSelectionFrame: number | null = null;

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
    this.getSendButtonRunning = options.getSendButtonRunning ?? (() => false);
    this.getHasAttachments = options.getHasAttachments;
    this.getHasPendingAttachments = options.getHasPendingAttachments;
    this.submit = options.submit;
    this.stop = options.stop;

    let removeSlashToken: (() => void) | undefined;
    this.editor = new Editor({
      // Use the factory's div as ProseMirror's actual mount node. Passing the
      // element directly would make Tiptap append a second `.ProseMirror`
      // child, which complicates focus, sizing, and the shared DOM contract.
      element: { mount: this.input },
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        UndoRedo,
        Markdown.configure({
          markedOptions: { gfm: true, breaks: true },
        }),
        NoteReference,
        ComposerSkillToken,
        ComposerSlashToken.configure({
          onRemove: () => removeSlashToken?.(),
        }),
      ],
      content: options.initialDraft || "",
      contentType: "markdown",
      editorProps: {
        attributes: {
          class: "agent-thread-card__composer-editor",
          spellcheck: "true",
          "aria-label": this.input.dataset.placeholder ?? "",
        },
        clipboardTextSerializer(content) {
          return content.content.textBetween(0, content.content.size, "\n", "");
        },
        transformPastedText: (text) => removeComposerControlCharacters(text),
        // Fallback for WebViews that skip beforeinput but still forward the
        // resulting text through ProseMirror's text-input hook.
        handleTextInput: (_view, _from, _to, text) =>
          composerControlCharacterPattern.test(text),
      },
      onUpdate: () => this.handleEditorUpdate(),
    });

    // When an existing mount element is passed to Tiptap, it replaces the
    // element's class attribute with its own `tiptap ProseMirror` classes.
    // Restore the composer-owned hooks after initialization so document
    // editor styles can explicitly exclude this nested editor.
    this.input.classList.add(
      "agent-thread-card__composer-input",
      "agent-thread-card__composer-editor",
    );

    this.slashCommands = new ComposerSlashCommandController({
      editor: this.editor,
      input: this.input,
      composer: this.composer,
      agentType: options.agentType,
      listDshSkills: options.listDshSkills,
      listCodexSkills: options.listCodexSkills,
      onModelSelect: options.onModelSelect,
      onPermissionSelect: options.onPermissionSelect,
      onDirectCommand: options.onDirectCommand,
      onCommandChange: () => this.handleEditorUpdate(),
      focusInput: () => this.focus(),
    });
    removeSlashToken = () => this.slashCommands.removeSelectedToken();

    // macOS routes Cmd+A through the native menu, bypassing the DOM keymap.
    // Share its action while keeping selection scoped to the focused composer.
    this.removeSelectAllHandler = pushHandler(
      "editor.selectAll",
      () => this.editor.commands.selectAll(),
      { isActive: () => !this.disposed && !this.editor.isDestroyed && this.editor.view.hasFocus() },
    );

    // Capture before ProseMirror's own keymap so plain Enter submits without
    // first inserting an empty paragraph into the composer document.
    this.input.addEventListener("keydown", this.handleKeydown, true);
    this.input.addEventListener("beforeinput", this.handleBeforeInput, true);
    this.input.addEventListener("compositionstart", this.handleCompositionStart);
    this.input.addEventListener("compositionend", this.handleCompositionEnd);
    this.input.addEventListener("blur", this.handleBlur);
    this.editor.on("selectionUpdate", this.handleSelectionUpdate);

    this.suppressUpdates = false;
    this.updateMultiLineState();
  }

  get editorInstance(): Editor {
    return this.editor;
  }

  getPrompt(): string {
    if (this.editor.isDestroyed) return "";
    // A plain composer newline is represented internally as a ProseMirror
    // hardBreak. Markdown serializes that node as `  \n`; the agent protocol
    // should receive the same newline the user entered, without Markdown's
    // visual line-break marker becoming part of the prompt.
    return composerSkillMarkdownToPrompt(composerSlashMarkdownToPrompt(this.getDraftMarkdown()))
      .replace(/ {2}\n/g, "\n");
  }

  getInputElement(): HTMLDivElement {
    return this.input;
  }

  focus(): void {
    if (this.disposed || this.editor.isDestroyed) return;
    this.editor.commands.focus(null, { scrollIntoView: false });
    // Tiptap's focus command schedules its final view focus in an animation
    // frame. Focus the current view synchronously as well so a click on the
    // expanded/fullscreen input row is ready for the very next keystroke.
    this.editor.view.focus();
  }

  persistInputDraft(value: string = this.getDraftMarkdown()): void {
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

  clear(): void {
    if (this.editor.isDestroyed) return;
    this.editor
      .chain()
      .setContent("", { contentType: "markdown", emitUpdate: false })
      .focus(null, { scrollIntoView: false })
      .run();
    this.updateMultiLineState();
  }

  resetHistoryNavigation(): void {
    this.historyCursor = null;
    this.preNavDraft = null;
  }

  setHistoryValue(
    content: string,
    options: { persistDraft?: boolean } = {},
  ): void {
    if (this.editor.isDestroyed) return;
    this.editor
      .chain()
      .setContent(content, { contentType: "markdown", emitUpdate: false })
      .focus("end", { scrollIntoView: false })
      .run();
    if (options.persistDraft) this.persistInputDraft(content);
    this.updateMultiLineState();
  }

  insertMemoReference(ref: MemoRef): void {
    if (this.editor.isDestroyed) return;

    const { selection, doc } = this.editor.state;
    const from = selection.from;
    const to = selection.to;
    const before = from > 0 ? doc.textBetween(from - 1, from, "\n", "\n") : "";
    const after = to < doc.content.size
      ? doc.textBetween(to, to + 1, "\n", "\n")
      : "";
    const content: Array<Record<string, unknown>> = [];

    if (before && !/\s/.test(before)) content.push({ type: "text", text: " " });
    content.push({
      type: "noteReference",
      attrs: {
        memoId: ref.id,
        notebookId: null,
        notebookName: "",
        title: ref.title || ref.filename,
        originalPath: null,
        stale: false,
      },
    });
    if (after && !/\s/.test(after)) content.push({ type: "text", text: " " });

    this.editor
      .chain()
      .focus(null, { scrollIntoView: false })
      .insertContentAt({ from, to }, content)
      .run();
    this.resetHistoryNavigation();
    this.persistInputDraft();
    this.updateMultiLineState();
  }

  updateMultiLineState(): void {
    const prompt = this.getPrompt();
    if (prompt === "") {
      this.composer.classList.remove("agent-thread-card__composer--multi-line");
      this.setSendButtonState("");
      return;
    }

    const isMulti = this.input.scrollHeight > 30;
    this.composer.classList.toggle(
      "agent-thread-card__composer--multi-line",
      isMulti,
    );
    this.setSendButtonState(prompt.trim());
  }

  setSendButtonState(inputValue: string = this.getPrompt().trim()): void {
    if (this.disposed) return;
    const isRunning = this.getSendButtonRunning();
    const { wantStop, disabled } = selectAgentThreadCardSendButtonState({
      wantStop: this.getSendButtonWantsStop(),
      inputValue,
      isRunning,
      hasAttachments: this.getHasAttachments(),
      hasPendingAttachments: this.getHasPendingAttachments(),
    });
    renderAgentThreadCardSendButton({
      root: this.sendButtonRoot,
      label: this.getSendLabel(wantStop, isRunning),
      wantStop,
      isRunning,
      disabled,
      onStop: this.stop,
      onSubmit: this.submit,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeSelectAllHandler();
    this.input.removeEventListener("keydown", this.handleKeydown, true);
    this.input.removeEventListener("beforeinput", this.handleBeforeInput, true);
    this.input.removeEventListener("compositionstart", this.handleCompositionStart);
    this.input.removeEventListener("compositionend", this.handleCompositionEnd);
    this.input.removeEventListener("blur", this.handleBlur);
    this.editor.off("selectionUpdate", this.handleSelectionUpdate);
    this.slashCommands.dispose();
    if (this.scrollSelectionFrame !== null) {
      cancelAnimationFrame(this.scrollSelectionFrame);
      this.scrollSelectionFrame = null;
    }
    if (!this.editor.isDestroyed) this.editor.destroy();
    const root = this.sendButtonRoot;
    queueMicrotask(() => root.unmount());
  }

  private readonly handleEditorUpdate = (): void => {
    if (this.suppressUpdates || this.disposed) return;
    if (!this.isCurrentHistoryEntryUnmodified()) this.resetHistoryNavigation();
    if (!this.isComposing) this.persistInputDraft();
    this.updateMultiLineState();
    this.scheduleScrollSelectionIntoView();
  };

  private getDraftMarkdown(): string {
    return this.editor.getMarkdown();
  }

  private readonly handleSelectionUpdate = (): void => {
    if (!this.disposed) this.slashCommands.refresh();
  };

  /**
   * Keep the caret visible when a hard break grows the editor past its
   * max-height. The editor height/class can change during the update, so wait
   * until the next frame before measuring the selection. Adjusting this
   * element's scrollTop directly avoids dispatching a second ProseMirror
   * transaction, which can leave a stale caret paint in WebViews.
   */
  private scheduleScrollSelectionIntoView(): void {
    if (this.disposed || this.editor.isDestroyed) return;

    if (this.scrollSelectionFrame !== null) {
      cancelAnimationFrame(this.scrollSelectionFrame);
    }

    this.scrollSelectionFrame = requestAnimationFrame(() => {
      this.scrollSelectionFrame = null;
      if (this.disposed || this.editor.isDestroyed) return;

      let top: number;
      let bottom: number;
      try {
        ({ top, bottom } = this.editor.view.coordsAtPos(
          this.editor.state.selection.head,
          1,
        ));
      } catch {
        // A hidden or jsdom-backed editor may not expose layout rectangles.
        // The editor remains usable; there is simply no geometry to adjust.
        return;
      }
      const inputRect = this.input.getBoundingClientRect();
      const selectionTop = top - inputRect.top + this.input.scrollTop;
      const selectionBottom = bottom - inputRect.top + this.input.scrollTop;
      const padding = 4;
      const visibleTop = this.input.scrollTop + padding;
      const visibleBottom =
        this.input.scrollTop + this.input.clientHeight - padding;

      if (selectionTop < visibleTop) {
        this.input.scrollTop = Math.max(0, selectionTop - padding);
      } else if (selectionBottom > visibleBottom) {
        this.input.scrollTop = Math.max(
          0,
          Math.min(
            this.input.scrollHeight - this.input.clientHeight,
            selectionBottom - this.input.clientHeight + padding,
          ),
        );
      }
    });
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.isComposing || event.isComposing || event.keyCode === 229) return;

    // The composer is a nested contenteditable inside the document editor.
    // Horizontal cursor events belong to the nested composer, never to the
    // document editor around the card. At either text boundary WebKit may let
    // a repeated key escape the nested contenteditable and move focus to the
    // parent editor. The key cannot move the composer cursor any further at
    // that point, so cancelling its default action is intentional.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (this.isAtComposerBoundary(event)) event.preventDefault();
      event.stopPropagation();
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!this.shouldHandleHistoryKey(event.key)) return;
      event.preventDefault();
      this.navigateHistory(event.key === "ArrowUp" ? "up" : "down");
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    this.submit();
  };

  private isAtComposerBoundary(event: KeyboardEvent): boolean {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
    const { selection, doc } = this.editor.state;
    if (!selection.empty) return false;
    return event.key === "ArrowLeft"
      ? selection.from <= 1
      : selection.to >= doc.content.size - 1;
  }

  private readonly handleBeforeInput = (event: InputEvent): void => {
    if (this.isComposing || event.isComposing) return;
    if (
      event.inputType !== "insertText" &&
      event.inputType !== "insertReplacementText"
    ) {
      return;
    }

    const data = event.data;
    if (!data || !composerControlCharacterPattern.test(data)) return;

    // The event is cancelled even when data contains other characters:
    // browsers do not provide a portable way to replace beforeinput data without duplicating the
    // editor transaction, and control-character input is always accidental.
    event.preventDefault();
  };

  private readonly handleCompositionStart = (): void => {
    this.isComposing = true;
  };

  private readonly handleCompositionEnd = (): void => {
    this.isComposing = false;
    this.handleEditorUpdate();
  };

  private readonly handleBlur = (): void => {
    this.flushPendingDraft();
  };

  private shouldHandleHistoryKey(key: string): boolean {
    const direction = key === "ArrowUp" ? "up" : "down";
    if (this.getUserHistoryMessages().length === 0) return false;
    if (!this.editor.state.selection.empty) return false;

    const { selection, doc } = this.editor.state;
    if (direction === "up") {
      return doc.textBetween(0, selection.from, "\n", "\n").indexOf("\n") === -1;
    }

    if (this.historyCursor === null) return false;
    return doc.textBetween(selection.to, doc.content.size, "\n", "\n").indexOf("\n") === -1;
  }

  private isCurrentHistoryEntryUnmodified(): boolean {
    if (this.historyCursor === null) return false;
    const messages = this.getUserHistoryMessages();
    return messages[this.historyCursor] === this.getPrompt();
  }

  private navigateHistory(direction: "up" | "down"): void {
    const messages = this.getUserHistoryMessages();
    if (messages.length === 0) return;

    if (direction === "up") {
      if (this.historyCursor === null && this.preNavDraft === null) {
        this.preNavDraft = this.getPrompt();
      }
      const next = this.historyCursor === null
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
      this.setHistoryValue(this.preNavDraft ?? "", { persistDraft: true });
      return;
    }
    this.historyCursor = next;
    this.setHistoryValue(messages[next]);
  }
}
