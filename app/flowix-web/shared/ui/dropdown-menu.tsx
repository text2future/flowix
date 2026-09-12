import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type DropdownAlign = "start" | "center" | "end";
type DropdownSide = "top" | "bottom";

const VIEWPORT_MARGIN = 4;
const FALLBACK_MENU_SIZE = 160;
const POSITION_STABILIZE_DELAY_MS = 50;

// Context for managing dropdown state
interface DropdownMenuContextValue {
	open: boolean;
	setOpen: (open: boolean) => void;
	triggerRef: React.RefObject<HTMLElement | null>;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(null);

function useDropdownContext() {
	const context = React.useContext(DropdownMenuContext);
	if (!context) {
		throw new Error("DropdownMenu components must be used within DropdownMenu");
	}
	return context;
}

interface DropdownMenuProps {
	children: React.ReactNode;
	className?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

interface DropdownTriggerChildProps {
	ref?: React.Ref<HTMLElement>;
	onClick?: React.MouseEventHandler<HTMLElement>;
	className?: string;
	"data-state"?: "open" | "closed";
}

interface DropdownMenuContentProps {
	children: React.ReactNode;
	align?: DropdownAlign;
	side?: DropdownSide;
	sideOffset?: number;
	className?: string;
	style?: React.CSSProperties;
	// Content 经 portal 渲染到 body, 触发器的 onMouseLeave 在其移入菜单时会先触发;
	// 由调用方配合延迟关闭实现 hover 型下拉窗。
	onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
	onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}

interface MenuPosition {
	top: number;
	left: number;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(value, max));
}

function getMenuPosition({
	triggerRect,
	menuWidth,
	menuHeight,
	align,
	side,
	sideOffset,
}: {
	triggerRect: DOMRect;
	menuWidth: number;
	menuHeight: number;
	align: DropdownAlign;
	side: DropdownSide;
	sideOffset: number;
}): MenuPosition {
	const top = side === "top"
		? triggerRect.top - menuHeight - sideOffset
		: triggerRect.bottom + sideOffset;

	const left = align === "center"
		? triggerRect.left + triggerRect.width / 2 - menuWidth / 2
		: align === "end"
			? triggerRect.right - menuWidth
			: triggerRect.left;

	return {
		top: clamp(top, VIEWPORT_MARGIN, window.innerHeight - menuHeight - VIEWPORT_MARGIN),
		left: clamp(left, VIEWPORT_MARGIN, window.innerWidth - menuWidth - VIEWPORT_MARGIN),
	};
}

function DropdownMenu({ children, className, open: controlledOpen, onOpenChange }: DropdownMenuProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLElement>(null);
	const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
	const setOpen = React.useCallback(
		(newOpen: boolean) => {
			if (controlledOpen === undefined) {
				setUncontrolledOpen(newOpen);
			}
			onOpenChange?.(newOpen);
		},
		[controlledOpen, onOpenChange]
	);

	return (
		<DropdownMenuContext.Provider value={{ open, setOpen, triggerRef }}>
			<div className={cn("relative", className)}>{children}</div>
		</DropdownMenuContext.Provider>
	);
}

function DropdownMenuTrigger({
	children,
	className,
	asChild,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
	const { open, setOpen, triggerRef } = useDropdownContext();

	const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		setOpen(!open);
		props.onClick?.(e);
	};

	// If asChild, expect a single child element that we can clone with merged props
	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<DropdownTriggerChildProps>;
		return React.cloneElement(child, {
			ref: (el: HTMLElement | null) => {
				triggerRef.current = el;
				const childRef = child.props.ref;
				if (typeof childRef === "function") childRef(el);
				else if (childRef && typeof childRef === "object") childRef.current = el;
			},
			onClick: handleClick,
			'data-state': open ? 'open' : 'closed',
		} as Record<string, unknown>);
	}

	return (
		<button
			ref={triggerRef as React.Ref<HTMLButtonElement>}
			onClick={handleClick}
			className={cn("cursor-pointer", className)}
			data-state={open ? "open" : "closed"}
			{...props}
		>
			{children}
		</button>
	);
}

function DropdownMenuContent({
	children,
	align = "start",
	side = "bottom",
	sideOffset = 4,
	className,
	style,
	onMouseEnter,
	onMouseLeave,
}: DropdownMenuContentProps) {
	const { open, setOpen, triggerRef } = useDropdownContext();
	const contentRef = React.useRef<HTMLDivElement>(null);
	const [position, setPosition] = React.useState<MenuPosition>({ top: 0, left: 0 });
	const [positioned, setPositioned] = React.useState(false);

	React.useLayoutEffect(() => {
		const trigger = triggerRef.current;
		if (!open || !trigger) {
			setPositioned(false);
			return;
		}

		let rafId = 0;
		let timeoutId = 0;

		const updatePosition = () => {
			const menu = contentRef.current;
			const menuWidth = menu?.offsetWidth ?? FALLBACK_MENU_SIZE;
			const menuHeight = menu?.offsetHeight ?? FALLBACK_MENU_SIZE;

			setPosition(getMenuPosition({
				triggerRect: trigger.getBoundingClientRect(),
				menuWidth,
				menuHeight,
				align,
				side,
				sideOffset,
			}));
			setPositioned(true);
		};

		updatePosition();
		rafId = requestAnimationFrame(updatePosition);
		timeoutId = window.setTimeout(updatePosition, POSITION_STABILIZE_DELAY_MS);

		window.addEventListener("scroll", updatePosition, true);
		window.addEventListener("resize", updatePosition);

		return () => {
			cancelAnimationFrame(rafId);
			window.clearTimeout(timeoutId);
			window.removeEventListener("scroll", updatePosition, true);
			window.removeEventListener("resize", updatePosition);
		};
	}, [open, triggerRef, side, sideOffset, align]);

	// Close on click outside
	// 用 pointerdown + capture 是因为:
	//   1) Tauri 2 在 macOS WKWebView 上对 data-tauri-drag-region 会注入 native
	//      drag overlay, 偶发吃掉 mousedown, 让 menu 在标题栏/侧栏其他位置关不掉。
	//      pointerdown 在 WebView2/webkit2gtk/WKWebView 触发时机更早, 命中率高。
	//   2) capture 阶段先于 base-ui <Tooltip> Trigger 内部的 pointerdown 处理,
	//      避免被 stopPropagation 短路。
	React.useEffect(() => {
		if (!open) return;

		const handleClickOutside = (e: PointerEvent) => {
			const target = e.target as Node;
			if (
				contentRef.current?.contains(target) ||
				triggerRef.current?.contains(target)
			) {
				return;
			}

			setOpen(false);
		};

		document.addEventListener("pointerdown", handleClickOutside, true);
		return () => document.removeEventListener("pointerdown", handleClickOutside, true);
	}, [open, setOpen, triggerRef]);

	// Close on escape
	React.useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open, setOpen]);

	if (!open) return null;
	if (typeof document === "undefined") return null;

	return createPortal(
		<div
			ref={contentRef}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			className={cn(
				"fixed z-[150] min-w-[160px] bg-[var(--card)] border border-[var(--border-popup)] rounded-lg shadow-lg py-1 animate-in fade-in-0 zoom-in-95",
				className
			)}
			style={{
				...style,
				top: position.top,
				left: position.left,
				visibility: positioned ? style?.visibility : "hidden",
				pointerEvents: positioned ? style?.pointerEvents : "none",
			}}
		>
			{children}
		</div>,
		document.body
	);
}

function DropdownMenuItem({
	children,
	className,
	disabled,
	onClick,
	onMouseDown,
	onTrailingAction,
	trailingAction,
	trailingActionLabel,
	inset,
	title,
}: {
	children: React.ReactNode;
	className?: string;
	disabled?: boolean;
	onClick?: () => void;
	onMouseDown?: (e: React.MouseEvent) => void;
	onTrailingAction?: () => void;
	trailingAction?: React.ReactNode;
	trailingActionLabel?: string;
	inset?: boolean;
	title?: string;
}) {
	const { setOpen } = useDropdownContext();

	const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		if (disabled) return;
		onClick?.();
		setOpen(false);
	};

	const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		e.stopPropagation();
		if (disabled) return;
		onMouseDown?.(e);
	};

	if (trailingAction) {
		return (
			<div
				className={cn(
					"flex items-center w-full text-sm text-[var(--foreground)] outline-none",
					"cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
					inset && "pl-8",
					className,
				)}
			>
				<button
					type="button"
					disabled={disabled}
					onClick={handleClick}
					onMouseDown={handleMouseDown}
					title={title}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
				>
					{children}
				</button>
				<button
					type="button"
					disabled={disabled}
					aria-label={trailingActionLabel}
					title={trailingActionLabel}
					onMouseDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						if (disabled) return;
						onTrailingAction?.();
						setOpen(false);
					}}
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-transparent hover:text-white focus-visible:text-white"
				>
					{trailingAction}
				</button>
			</div>
		);
	}

	return (
		<button
			disabled={disabled}
			onClick={handleClick}
			onMouseDown={handleMouseDown}
			title={title}
			className={cn(
				"flex items-center w-full px-3 py-1.5 text-sm text-[var(--foreground)] cursor-pointer outline-none disabled:cursor-not-allowed disabled:opacity-50",
				inset && "pl-8",
				className
			)}
		>
			{children}
		</button>
	);
}

function DropdownMenuLabel({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)]", className)}>
			{children}
		</div>
	);
}

function DropdownMenuSeparator() {
	return <div className="h-px bg-[var(--border)] my-1" />;
}

// Sub Menu
interface DropdownMenuSubProps {
	children: React.ReactNode;
}

function DropdownMenuSub({ children }: DropdownMenuSubProps) {
	return <div className="relative">{children}</div>;
}

interface DropdownMenuSubTriggerProps {
	children: React.ReactNode;
	className?: string;
	inset?: boolean;
}

function DropdownMenuSubTrigger({ children, className, inset }: DropdownMenuSubTriggerProps) {
	const [isOpen, setIsOpen] = React.useState(false);

	return (
		<div className="relative">
			<button
				onClick={() => setIsOpen(!isOpen)}
				className={cn(
					"flex items-center w-full px-3 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--muted)] cursor-pointer outline-none",
					inset && "pl-8",
					className
				)}
			>
				{children}
			</button>
			{isOpen && (
				<div className="absolute left-full ml-1 top-0 z-[151] min-w-[160px] bg-[var(--card)] border border-[var(--border-popup)] rounded-lg shadow-lg py-1">
					{/* This would need children passed differently - simplified for now */}
				</div>
			)}
		</div>
	);
}

function DropdownMenuSubContent({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"absolute left-full ml-1 top-0 z-[151] min-w-[160px] bg-[var(--card)] border border-[var(--border-popup)] rounded-lg shadow-lg py-1",
				className
			)}
		>
			{children}
		</div>
	);
}

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
	DropdownMenuContext,
	useDropdownContext,
};
