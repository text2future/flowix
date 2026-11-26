import type { AppLanguage } from "@/lib/i18n";
import type { I18nKey, I18nParams } from "@/lib/i18n";
import type { AgentTypeKey } from "@/types/agent";
import type { CloudAccessKind } from "@features/agent/config/cloud-access";
import type { ComposerSlashSkill } from "@features/agent/thread-card/composer/composer-slash-command-controller";
import type { AgentEmptyStatePresentation } from "./agent-empty-state-controller";

/** `ExternalAgentSettingsController` 的宿主注入面，类型与实现分离。 */
export interface ExternalAgentSettingsControllerOptions {
  popover: HTMLDivElement;
  getTypeKey: () => AgentTypeKey;
  /**
   * 返回当前卡片绑定的 instanceId ── 用于把 model/permission/reasoning
   * 控件读写路由到 instance.runtimeConfig 快照,
   * 实现"不同 Agent Thread Card 不共享配置"。如果 undefined (如编辑器临时预览),
   * 则退化为全局 useAgentSessionStore 行为, 不影响现有 fallback 路径。
   */
  getInstanceId: () => string | undefined;
  getLanguage: () => AppLanguage;
  getEmptyStatePresentation: () => AgentEmptyStatePresentation; // 形态变了必须重建空状态, 故参与复用判定
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  isRunning?: () => boolean;
  consumeOutsidePointer?: (event: PointerEvent) => void;
  onPopoverStateChange?: (
    open: boolean,
    anchor: HTMLButtonElement | null,
  ) => void;
  /**
   * 点击常用笔记卡片时的动作 ── 把该笔记作为行内引用注入 composer 输入框
   * (而不是打开笔记)。由宿主 (thread card view / 独立对话) 接到
   * `ComposerController.insertMemoReference`。
   */
  onSelectFeaturedNote?: (ref: { id: string; filename: string; title: string; notebookId?: string; relativePath?: string }) => void;
  /** Expanded empty-state prompt chips seed the shared composer without sending. */
  onSelectEmptyPrompt?: (prompt: string) => void;
  /** Expanded empty-state skill chips use the same token insertion as the slash menu. */
  onSelectEmptySkill?: (skill: ComposerSlashSkill) => void;
  /** Opens the shared slash picker with all commands and skills. */
  onOpenEmptySkills?: () => void;
  /**
   * 仓库列表增删后的轻提示。 由宿主注入而不是直接 import toast, 让本
   * controller 保持对 UI 反馈层的解耦 (测试里也可以只断言调用)。
   */
  toast?: (kind: "success" | "error" | "info", message: string) => void;
  /** A Cloud model cannot run yet: the host shows its sign-in notice. */
  onCloudAccessBlocked?: (kind: CloudAccessKind) => void;
}
