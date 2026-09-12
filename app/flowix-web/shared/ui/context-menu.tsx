import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface ContextMenuTriggerChildProps extends React.HTMLAttributes<HTMLElement> {}

// Context for managing context-menu state. Position is captured at the moment
// of the right-click, so the menu opens exactly at the cursor.
interface ContextMenuContextValue {
	open: boolean;
	position: { x: number; y: number } | null;
	setOpen: (open: boolean) => void;
	openAt: (x: number, y: number) => void;
}

const ContextMenuContext = React.createContext<ContextMenuContextValue | null>(null);
const CONTEXT_MENU_OPEN_EVENT = "flowix:context-menu-open";

function useContextMenuContext() {
	const context = React.useContext(ContextMenuContext);
	if (!context) {
		throw new Error("ContextMenu components must be used within ContextMenu");
	}
	return context;
}

interface ContextMenuProps {
	children: React.ReactNode;
	onOpenChange?: (open: boolean) => void;
}

function ContextMenu({ children, onOpenChange }: ContextMenuProps) {
	const [open, setOpen] = React.useState(false);
	const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);
	const ownerRef = React.useRef({});
	const updateOpen = React.useCallback((nextOpen: boolean) => {
		setOpen(nextOpen);
		onOpenChange?.(nextOpen);
	}, [onOpenChange]);

	// Context menus are rendered independently (for example, one per file-tree
	// row), so coordinate them through a document-level event. Opening one menu
	// closes any other menu and also clears its consumer's active state.
	React.useEffect(() => {
		const handleAnotherMenuOpen = (event: Event) => {
			const owner = (event as CustomEvent<object>).detail;
			if (owner !== ownerRef.current) updateOpen(false);
		};
		document.addEventListener(CONTEXT_MENU_OPEN_EVENT, handleAnotherMenuOpen);
		return () => document.removeEventListener(CONTEXT_MENU_OPEN_EVENT, handleAnotherMenuOpen);
	}, [updateOpen]);

	const openAt = React.useCallback((x: number, y: number) => {
		document.dispatchEvent(new CustomEvent(CONTEXT_MENU_OPEN_EVENT, {
			detail: ownerRef.current,
		}));
		setPosition({ x, y });
		updateOpen(true);
	}, [updateOpen]);

	const close = React.useCallback(() => {
		updateOpen(false);
		// Keep the last position until the menu finishes its close animation; the
		// content is unmounted when open is false so position becomes invisible
		// to the user either way.
	}, [updateOpen]);

	return (
		<ContextMenuContext.Provider value={{ open, position, setOpen: close, openAt }}>
			{children}
		</ContextMenuContext.Provider>
	);
}

interface ContextMenuTriggerProps extends React.HTMLAttributes<HTMLDivElement> {
	asChild?: boolean;
}

// `ContextMenuTrigger` is a div that opens the menu on right-click at the
// cursor's location. We intentionally suppress the native context menu and
// rely entirely on this component.
function ContextMenuTrigger({ children, className, onContextMenu, asChild, ...props }: ContextMenuTriggerProps) {
	const { openAt } = useContextMenuContext();

	const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		openAt(e.clientX, e.clientY);
		onContextMenu?.(e);
	};

	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<ContextMenuTriggerChildProps>;
		return React.cloneElement(child, {
			onContextMenu: handleContextMenu,
			className: cn(child.props.className, className),
			...props,
		} as Record<string, unknown>);
	}

	return (
		<div onContextMenu={handleContextMenu} className={className} {...props}>
			{children}
		</div>
	);
}

interface ContextMenuContentProps {
	children: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

function ContextMenuContent({ children, className, style }: ContextMenuContentProps) {
	const { open, position, setOpen } = useContextMenuContext();
	const contentRef = React.useRef<HTMLDivElement>(null);

	// Clamp the position so the menu never spills off-screen. The content can
	// change size after opening (for example, a tree menu first renders a
	// loading item and then replaces it with the full memo actions), so this is
	// deliberately a reusable measurement pass rather than a one-time effect.
	const clampToViewport = React.useCallback(() => {
		if (!open || !contentRef.current || !position) return;
		const el = contentRef.current;
		const margin = 4;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// A very tall menu must become internally scrollable. Otherwise a menu
		// larger than the viewport has no valid top coordinate that can keep it
		// inside the window.
		el.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
		el.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;
		el.style.overflowY = 'auto';

		const rect = el.getBoundingClientRect();
		const maxX = Math.max(margin, viewportWidth - rect.width - margin);
		const maxY = Math.max(margin, viewportHeight - rect.height - margin);
		const x = Math.max(margin, Math.min(position.x, maxX));
		const y = Math.max(margin, Math.min(position.y, maxY));
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
	}, [open, position]);

	// ResizeObserver keeps the menu aligned when asynchronous content changes
	// its height, while the layout effect handles the initial open before paint.
	React.useLayoutEffect(() => {
		clampToViewport();
		if (!open || !contentRef.current || typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver(() => clampToViewport());
		observer.observe(contentRef.current);
		return () => observer.disconnect();
	}, [clampToViewport, open]);

	// Close on any pointerdown outside the menu content.
	// 听 `pointerdown` 而不是 `mousedown`: tag / notebook 行上挂了
	// `useDragReorder` 的 `onPointerDown`, 该 handler 会 `e.preventDefault()` ──
	// 按 Pointer Events 规范, preventDefault on pointerdown 会取消对应的
	// mousedown, 导致 mousedown 不冒泡到 document, 菜单收不掉。 改听
	// pointerdown 可同时覆盖左键 / 触摸 / 笔, 且不被 preventDefault 阻断。
	React.useEffect(() => {
		if (!open) return;

		const handlePointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (contentRef.current?.contains(target)) return;
			setOpen(false);
		};

		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [open, setOpen]);

	// Close on Escape, scroll, or resize.
	React.useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		// scroll 触发场景里, 部分容器是"自身内容增长驱动的滚动" (例如 agent
		// thread card 在 streaming 期间每帧 `body.scrollTop = scrollHeight`) ──
		// 滚动事件是组件自身的内部行为, 不应牵连到全局右键菜单. 业务侧声明豁免
		// 容器: 在元素上加 `data-no-context-menu-scroll`, 这里的 closest 命中即
		// 跳过 setOpen(false)。`shared/ui/` 不依赖任何业务类名。
		const handleScroll = (e: Event) => {
			const target = e.target as Element | null;
			if (target?.closest?.("[data-no-context-menu-scroll]")) return;
			setOpen(false);
		};
		const handleResize = () => setOpen(false);

		document.addEventListener("keydown", handleKeyDown);
		window.addEventListener("scroll", handleScroll, true);
		window.addEventListener("resize", handleResize);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("scroll", handleScroll, true);
			window.removeEventListener("resize", handleResize);
		};
	}, [open, setOpen]);

	if (!open) return null;
	if (typeof document === "undefined") return null;

	return createPortal(
		<div
			ref={contentRef}
			role="menu"
			// Start at the cursor position; the layout effect above clamps
			// these values once the element's true size is known.
			style={{ left: position?.x ?? 0, top: position?.y ?? 0, ...style }}
			className={cn(
				"fixed z-[150] min-w-[160px] bg-[var(--card)] border border-[var(--border-popup)] rounded-lg shadow-lg py-1 animate-in fade-in-0 zoom-in-95",
				className
			)}
		>
			{children}
		</div>,
		document.body
	);
}

interface ContextMenuItemProps {
	"aria-describedby"?: string;
	children: React.ReactNode;
	className?: string;
	onClick?: () => void;
	onSelect?: () => void;
	disabled?: boolean;
	inset?: boolean;
}

function ContextMenuItem({
	"aria-describedby": ariaDescribedBy,
	children,
	className,
	onClick,
	onSelect,
	disabled,
	inset,
}: ContextMenuItemProps) {
	const { setOpen } = useContextMenuContext();

	const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		if (disabled) return;
		onClick?.();
		onSelect?.();
		setOpen(false);
	};

	return (
		<button
			type="button"
			role="menuitem"
			aria-describedby={ariaDescribedBy}
			disabled={disabled}
			onClick={handleClick}
			onMouseDown={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			className={cn(
				"flex items-center w-full px-3 py-1.5 text-sm text-[var(--foreground)] cursor-pointer outline-none",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				inset && "pl-8",
				className
			)}
		>
			{children}
		</button>
	);
}

function ContextMenuLabel({
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

function ContextMenuSeparator() {
	return <div role="separator" className="h-px bg-[var(--border)] my-1" />;
}

function ContextMenuShortcut({ children }: { children: React.ReactNode }) {
	return (
		<span className="ml-auto text-xs tracking-widest text-[var(--muted-foreground)]">
			{children}
		</span>
	);
}

export {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuContext,
	useContextMenuContext,
};
