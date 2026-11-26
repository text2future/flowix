import type { AgentTypeKey } from "@/types/agent";

/**
 * 模型目录正在拉取的 agent 类型（仅当无可用缓存时置位）。显式区分
 * "加载中 / 加载完成但为空 / 加载失败"，加载期间按钮与弹层显示
 * "正在读取模型"，避免把未就绪的数据误渲染成结果。
 */
export class ModelCatalogLoadTracker {
  private inFlight: AgentTypeKey | null = null;

  /** 拉取开始且无缓存可用 → 进入加载态。 */
  begin(typeKey: AgentTypeKey): void {
    if (this.inFlight === typeKey) return;
    this.inFlight = typeKey;
  }

  end(typeKey: AgentTypeKey): void {
    if (this.inFlight === typeKey) this.inFlight = null;
  }

  /** 当前 agent 类型是否处于目录加载中。 */
  isCurrentLoading(typeKey: AgentTypeKey): boolean {
    return this.inFlight !== null && this.inFlight === typeKey;
  }
}
