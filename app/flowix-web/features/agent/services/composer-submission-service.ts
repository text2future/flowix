import { CloudAccessBlockedError } from "@features/agent/config/cloud-access";
import { openCloudLoginDialog } from "@features/preferences/public/cloud-login-dialog";
import { openCloudCreditsDialog } from "@features/agent/thread-card/cloud-access/cloud-credits-dialog";
import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { createLogger } from "@/lib/logger";
import { toast } from "@/lib/toast";
import { dialogs } from "@platform/tauri/client/desktop";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { createAgentMessageAttachments } from "@features/agent/store/user-message";
import { markConversationWorkspaceStarted } from "@features/agent/runtime/workspace-snapshot";
import type { ComposerSubmissionSnapshot } from "@features/agent/thread-card/composer/composer-submission-controller";
import { isAgentThreadCardImageAttachment } from "@features/agent/thread-card/composer/composer-attachment-types";
import type { ComposerSubmissionKind } from "@features/agent/thread-card/composer/composer-submission-state";
import { runDshCommand } from "./dsh-command-service";
import {
  beginCodexSlashCommand, createCodexCommandLifecycle,
  executeCodexSlashCommand, finishCodexSlashCommand,
} from "./codex-slash-command-service";

export interface ComposerConversationBinding {
  instanceId: string;
  threadId: string;
  typeKey: AgentTypeKey;
  title: string;
  runtimeConfig: RuntimeConfig | null;
  isFirstMessage: boolean;
  runId?: string;
}

const logger = createLogger("composer-submission");

/** Shared acceptance boundary for both composer hosts and all send entrypoints. */
export async function acceptComposerSubmission(
  bound: ComposerConversationBinding,
  snapshot: ComposerSubmissionSnapshot,
  kind: ComposerSubmissionKind,
  documentContext?: string,
): Promise<void> {
  const imageAttachments = snapshot.attachments.filter(isAgentThreadCardImageAttachment);
  const imagePaths = imageAttachments.map((image) => image.path);
  if (kind === "message") {
    try {
      await useAgentSessionStore.getState().sendMessageToThread(
        bound.threadId, snapshot.prompt, bound.typeKey, {
          instanceId: bound.instanceId, conversationTitle: bound.title,
          runtimeConfig: bound.runtimeConfig, isFirstMessage: bound.isFirstMessage,
          runId: bound.runId,
          currentNoteContent: documentContext, imagePaths,
          displayContent: snapshot.displayContent,
          attachments: createAgentMessageAttachments(imageAttachments),
          rejectOnFailure: true,
        },
      );
    } catch (error) {
      if (error instanceof CloudAccessBlockedError) {
        if (error.kind === "signed_out") void openCloudLoginDialog();
        else void openCloudCreditsDialog();
      }
      throw error;
    }
  } else if (bound.typeKey === "dsh") {
    await runDshCommand({
      command: snapshot.prompt, imagePaths, rejectOnFailure: true,
      ensureConversation: async () => bound,
      onLogError: (message, error) => logger.error(message, { error }),
      onSaveExport: async (filename, content) => {
        // Export/save errors happen after command acceptance; do not turn
        // them into a rejected command that users may accidentally rerun.
        try {
          const target = await dialogs.saveFile(filename, [{ name: "JSON", extensions: ["json"] }]);
          if (!target) return;
          const written = await dialogs.writeExportFile(target, content);
          toast[written ? "success" : "error"](written ? "DSH 会话已导出。" : "DSH 会话导出失败。");
        } catch (error) {
          logger.error("Failed to save DSH export", { error });
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },
    });
  } else if (bound.typeKey === "codex") {
    const lifecycle = createCodexCommandLifecycle(bound.threadId);
    beginCodexSlashCommand(bound.threadId, snapshot.prompt, lifecycle);
    try {
      const cwd = bound.runtimeConfig?.workspaceSnapshot?.cwd ?? bound.runtimeConfig?.cwd;
      await executeCodexSlashCommand(bound.threadId, snapshot.prompt, cwd, lifecycle);
    } catch (error) {
      finishCodexSlashCommand(bound.threadId, snapshot.prompt, lifecycle, "error",
        error instanceof Error ? error.message : String(error));
      throw error;
    }
    // History refresh failure cannot revoke an already accepted command.
    await useAgentSessionStore.getState().loadMessages("codex", bound.threadId)
      .catch((error) => logger.error("Failed to refresh Codex command history", { error }));
  } else {
    throw new Error("This Agent does not support native slash commands");
  }
  markConversationWorkspaceStarted(bound.instanceId);
}
