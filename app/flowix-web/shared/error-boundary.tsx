import { Component, Fragment, ErrorInfo, ReactNode } from "react";
import { translate, type AppLanguage, DEFAULT_APP_LANGUAGE } from "@/lib/i18n";
import { createLogger } from "@/lib/logger";
import { Button } from "@shared/ui/button";

const logger = createLogger("error-boundary");

function isWindowsPlatform(): boolean {
	return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function isMacPlatform(): boolean {
	return /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);
}

function isTauriApp(): boolean {
	return typeof window !== "undefined"
		&& ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
	language?: AppLanguage;
	onReturnHome?: () => void | Promise<void>;
	onError?: (error: Error, errorInfo: ErrorInfo) => void;
	/** 这些值变化时自动重试，避免"换了文档仍停在错误页"。 */
	resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
	hasError: boolean;
	error?: Error;
	homeError: boolean;
	/** 每次重试自增，作为 children 的 key 强制重新挂载子树。 */
	epoch: number;
}

/**
 * Error Boundary component to catch React errors and display fallback UI
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, homeError: false, epoch: 0 };
	}

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		document.getElementById("app-loading")?.remove();
		// 走统一日志通道，避免绕过 createLogger 的 console 直调（债务门禁会拦）。
		logger.error("caught render error", {
			message: error.message,
			stack: error.stack ?? "<no stack>",
			componentStack: errorInfo.componentStack,
		});
		this.props.onError?.(error, errorInfo);
	}

	componentDidUpdate(previous: ErrorBoundaryProps): void {
		if (!this.state.hasError) return;
		const before = previous.resetKeys ?? [];
		const after = this.props.resetKeys ?? [];
		if (before.length !== after.length || before.some((key, index) => key !== after[index])) {
			this.handleRetry();
		}
	}

	handleRetry = (): void => {
		// 只清 error 会让确定性错误立即再次抛出（用户看到永远无效的"重试"）。
		// 同时递增 epoch，用 key 重新挂载子树，给上层一次真正的重建机会。
		this.setState((state) => ({ hasError: false, error: undefined, homeError: false, epoch: state.epoch + 1 }));
	};

	handleReturnHome = async (): Promise<void> => {
		this.setState({ homeError: false });
		try {
			await this.props.onReturnHome?.();
			this.handleRetry();
		} catch (error) {
			logger.error("return to home failed", {
				message: error instanceof Error ? error.message : String(error),
			});
			this.setState({ homeError: true });
		}
	};

	render(): ReactNode {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			const lang = this.props.language ?? DEFAULT_APP_LANGUAGE;
			const isWindows = isWindowsPlatform();
			const showDragRegion = isTauriApp() && (isWindows || isMacPlatform());

			return (
				<div className="flex h-full flex-col text-center">
					{showDragRegion && (
						<div
							data-tauri-drag-region
							aria-hidden="true"
							className="h-[var(--window-titlebar-height)] w-full flex-none bg-[var(--bg-titlebar)]"
						/>
					)}
					<div className="flex flex-1 flex-col items-center justify-center p-8">
						<div className="flex -translate-y-20 flex-col items-center">
							<div className="mb-4 text-destructive">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									className="w-12 h-12 mx-auto"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={1.5}
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
							</div>
							<h2 className="text-lg font-semibold text-foreground mb-2">{translate(lang, "error.title")}</h2>
							<p className="text-sm text-muted-foreground mb-4">
								{this.state.error?.message || translate(lang, "error.unexpected")}
							</p>
							{this.state.homeError && (
								<p role="alert" className="text-sm text-destructive mb-4">
									{translate(lang, "error.homeFailed")}
								</p>
							)}
							<div className="flex items-center gap-2">
								<Button variant="outline" className="px-3" onClick={this.handleRetry}>
									{translate(lang, "error.retry")}
								</Button>
								{this.props.onReturnHome && (
									<Button variant="outline" className="px-3" onClick={() => void this.handleReturnHome()}>
										{translate(lang, "error.home")}
									</Button>
								)}
							</div>
						</div>
					</div>
				</div>
			);
		}

		return <Fragment key={this.state.epoch}>{this.props.children}</Fragment>;
	}
}
