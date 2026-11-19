import type { ComposerController } from "./composer-controller";
import type { ComposerAttachmentController } from "./composer-attachment-controller";
import type { AgentThreadCardInputAttachment } from "./composer-attachment-types";
import {
  selectComposerSubmissionState,
  type ComposerRuntimeState,
  type ComposerSubmissionKind,
} from "./composer-submission-state";

export type ComposerSubmissionPhase =
  | "idle"
  | "preparing"
  | "binding"
  | "accepting"
  | "accepted"
  | "failed";

export interface ComposerSubmissionSnapshot {
  markdown: string;
  prompt: string;
  displayContent: string;
  attachments: AgentThreadCardInputAttachment[];
}

type SubmissionComposer = Pick<
  ComposerController,
  | "getPrompt"
  | "getDraftMarkdown"
  | "flushPendingDraft"
  | "clearDraft"
  | "clear"
  | "setHistoryValue"
  | "resetHistoryNavigation"
  | "updateMultiLineState"
> & Partial<Pick<ComposerController, "getDisplayContent">>;

function combineDraftsForRetry(submitted: string, current: string): string {
  if (!submitted) return current;
  if (!current) return submitted;
  return `${submitted}\n${current}`;
}

function restoreDraftForRetry(composer: SubmissionComposer, submitted: string): void {
  const current = composer.getDraftMarkdown();
  const restored = combineDraftsForRetry(submitted, current);
  if (restored !== current) composer.setHistoryValue(restored, { persistDraft: true });
}

/** Clears on dispatch for responsive feedback and restores the draft on rejection. */
export class ComposerSubmissionController {
  phase: ComposerSubmissionPhase = "idle";
  snapshot: ComposerSubmissionSnapshot | null = null;

  get isSubmitting(): boolean {
    return (
      this.phase === "preparing" ||
      this.phase === "binding" ||
      this.phase === "accepting"
    );
  }

  async submit<T>(options: {
    composer: SubmissionComposer;
    images: Pick<
      ComposerAttachmentController,
      "hasAttachments" | "hasPending" | "readyAttachments" | "setLocked" | "clearAfterSubmit"
    >;
    getRuntime: () => ComposerRuntimeState;
    isDisposed: () => boolean;
    bind: (snapshot: ComposerSubmissionSnapshot, kind: ComposerSubmissionKind) => Promise<T>;
    accept: (
      bound: T,
      snapshot: ComposerSubmissionSnapshot,
      kind: ComposerSubmissionKind,
    ) => Promise<void>;
    clearPersistedDraft: () => void;
    onPhaseChange: () => void;
    onError: (error: unknown) => void;
  }): Promise<void> {
    const { composer, images } = options;
    const state = selectComposerSubmissionState({
      ...options.getRuntime(),
      isSubmitting: this.isSubmitting,
      prompt: composer.getPrompt(),
      hasAttachments: images.hasAttachments,
      hasPendingAttachments: images.hasPending,
    });
    if (options.isDisposed() || !state.canSubmit) return;

    const snapshot: ComposerSubmissionSnapshot = {
      markdown: composer.getDraftMarkdown(),
      prompt: composer.getPrompt().trim() || "Analyze the attached image(s).",
      displayContent: (composer.getDisplayContent?.() ?? composer.getDraftMarkdown()).trim(),
      attachments: images.readyAttachments.map((attachment) => ({ ...attachment })),
    };
    this.snapshot = snapshot;
    const transition = (phase: ComposerSubmissionPhase): void => {
      this.phase = phase;
      if (!options.isDisposed()) options.onPhaseChange();
    };
    let submittedDraftCleared = false;
    const clearSubmittedDraft = (): unknown => {
      if (options.isDisposed() || composer.getDraftMarkdown() !== snapshot.markdown) {
        return undefined;
      }
      try {
        composer.clearDraft();
        composer.clear();
        composer.resetHistoryNavigation();
        submittedDraftCleared = true;
        options.clearPersistedDraft();
        return undefined;
      } catch (error) {
        // Cleanup can fail after the editor has cleared. Track that case so a
        // rejected request still restores the input.
        submittedDraftCleared ||= composer.getDraftMarkdown() !== snapshot.markdown;
        return error;
      }
    };
    transition("preparing");
    images.setLocked(true);
    try {
      composer.flushPendingDraft();
      transition("binding");
      const bound = await options.bind(snapshot, state.kind);
      if (options.isDisposed()) return;
      transition("accepting");
      // Recheck thread work after asynchronous binding. A newly pending
      // command/stop must not turn a prepared request into an invalid send.
      if (!selectComposerSubmissionState({
        ...options.getRuntime(),
        isSubmitting: false,
        prompt: snapshot.prompt,
        hasAttachments: snapshot.attachments.length > 0,
        hasPendingAttachments: false,
        kind: state.kind,
      }).canSubmit) {
        throw new Error("Agent is busy; please retry when the current operation finishes.");
      }
      // Dispatch can update the message list before its promise resolves.
      // Clear now and keep the snapshot for rollback if the request is rejected.
      const acceptance = options.accept(bound, snapshot, state.kind);
      const cleanupError = clearSubmittedDraft();
      await acceptance;
      if (options.isDisposed()) return;
      // Acceptance is irreversible. A subsequent UI cleanup error must
      // never describe the request as rejected and invite an unsafe retry.
      transition("accepted");
      if (cleanupError !== undefined) throw cleanupError;
      images.clearAfterSubmit();
      this.snapshot = null;
    } catch (error) {
      if (this.phase !== "accepted") transition("failed");
      if (!options.isDisposed()) {
        if (this.phase !== "accepted" && submittedDraftCleared) {
          try {
            restoreDraftForRetry(composer, snapshot.markdown);
          } catch {
            // Keep the original rejection as the actionable error. The
            // submission snapshot also remains available for recovery.
          }
        }
        options.onError(error);
      }
    } finally {
      // A disposed surface must not receive late callbacks or DOM writes.
      if (!options.isDisposed()) {
        images.setLocked(false);
        composer.updateMultiLineState();
      }
      if (this.isSubmitting) this.phase = "idle";
    }
  }
}
