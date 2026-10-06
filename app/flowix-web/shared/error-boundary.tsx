import { Component, ErrorInfo, ReactNode } from "react";
import { translate, type AppLanguage, DEFAULT_APP_LANGUAGE } from "@/lib/i18n";

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
	onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error?: Error;
}

/**
 * Error Boundary component to catch React errors and display fallback UI
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		document.getElementById("app-loading")?.remove();
		console.error("[ErrorBoundary] Caught error:", error, errorInfo);
		this.props.onError?.(error, errorInfo);
	}

	handleRetry = (): void => {
		this.setState({ hasError: false, error: undefined });
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
							className={`${isWindows ? "h-9" : "h-12"} w-full flex-none bg-[var(--bg-titlebar)]`}
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
							<button
								onClick={this.handleRetry}
								className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-[color-mix(in_oklch,var(--primary)_90%,transparent)] transition-colors text-sm font-medium"
							>
								{translate(lang, "error.retry")}
							</button>
						</div>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
