import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { createLogger } from "@/lib/logger";
import { DEFAULT_APP_LANGUAGE, translate, type AppLanguage } from "@/lib/i18n";

const logger = createLogger("surface-boundary");

export interface SurfaceBoundaryProps {
  /** 仅用于日志定位（例如 "memo-list" / "work-column"），不是展示文案。 */
  name: string;
  language?: AppLanguage;
  /**
   * 这些值变化时自动重置边界。用于"换了一个文档/笔记本后重新尝试渲染"，
   * 避免一次崩溃把整个面板钉死在错误态。
   */
  resetKeys?: readonly unknown[];
  fallback?: (retry: () => void, error: Error) => ReactNode;
  children: ReactNode;
}

interface SurfaceBoundaryState {
  error: Error | null;
  /** 每次重试自增，作为 children 的 key 触发真正重新挂载。 */
  epoch: number;
}

/**
 * 面板级错误边界。
 *
 * 与根 `ErrorBoundary` 的分工：根边界负责"整窗不可用"，这里负责
 * "某个面板崩了但其余区域继续可用"。React 的边界只捕获渲染阶段错误，
 * 命令式 DOM 与异步回调里的异常需要各自的 try/catch。
 *
 * 不额外包一层 div（用带 key 的 Fragment），避免改变 flex 布局结构。
 */
export class SurfaceBoundary extends Component<SurfaceBoundaryProps, SurfaceBoundaryState> {
  state: SurfaceBoundaryState = { error: null, epoch: 0 };

  static getDerivedStateFromError(error: Error): Partial<SurfaceBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error(`surface crashed: ${this.props.name}`, {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  componentDidUpdate(previous: SurfaceBoundaryProps): void {
    if (!this.state.error) return;
    const before = previous.resetKeys ?? [];
    const after = this.props.resetKeys ?? [];
    if (before.length !== after.length || before.some((key, index) => key !== after[index])) {
      this.retry();
    }
  }

  private retry = (): void => {
    this.setState((state) => ({ error: null, epoch: state.epoch + 1 }));
  };

  render(): ReactNode {
    const { error, epoch } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(this.retry, error);
      const language = this.props.language ?? DEFAULT_APP_LANGUAGE;
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium text-foreground">
            {translate(language, "error.surfaceTitle")}
          </p>
          <button
            type="button"
            onClick={this.retry}
            className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs text-foreground transition-colors hover:bg-[var(--muted)]"
          >
            {translate(language, "error.surfaceRetry")}
          </button>
        </div>
      );
    }
    return <Fragment key={epoch}>{this.props.children}</Fragment>;
  }
}
