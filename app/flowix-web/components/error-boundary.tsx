import { Component, ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
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

			return (
				<div className="flex flex-col items-center justify-center h-full p-8 text-center">
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
					<h2 className="text-lg font-semibold text-foreground mb-2">出错了</h2>
					<p className="text-sm text-muted-foreground mb-4">
						{this.state.error?.message || "发生了意外错误"}
					</p>
					<button
						onClick={this.handleRetry}
						className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-[color-mix(in_oklch,var(--primary)_90%,transparent)] transition-colors text-sm font-medium"
					>
						重试
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}