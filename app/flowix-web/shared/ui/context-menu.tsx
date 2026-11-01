import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { POPUP_SEPARATOR_CLASS } from "@shared/ui/popup-separator";

interface ContextMenuTriggerChildProps extends React.HTMLAttributes<HTMLElement> {}

type ContextMenuCloseReason = 'select' | 'escape' | 'outside' | 'scroll' | 'resize' | 'replace' | 'tab';

// Context for managing context-menu state. Position is captured at the moment
// of the right-click, so the menu opens exactly at the cursor.
interface ContextMenuContextValue {
	open: boolean;
	position: { x: number; y: number } | null;
	setOpen: (open: boolean) => void;
	openAt: (x: number, y: number, trigger?: HTMLElement) => void;
	triggerRef: React.RefObject<HTMLElement | null>;
	menuId: string;
	close: (reason: ContextMenuCloseReason) => void;
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
	const triggerRef = React.useRef<HTMLElement | null>(null);
	const menuId = React.useId();
	const updateOpen = React.useCallback((nextOpen: boolean) => {
		setOpen(nextOpen);
		onOpenChange?.(nextOpen);
	}, [onOpenChange]);
	const close = React.useCallback((reason: ContextMenuCloseReason) => {
		const active = document.activeElement;
		const ownsFocus = active instanceof Element
			&& active.closest('[data-context-menu-owner]')?.getAttribute('data-context-menu-owner') === menuId;
		const trigger = triggerRef.current;
		if (ownsFocus && trigger?.isConnected && (reason === 'escape' || reason === 'select' || reason === 'tab')) {
			// Non-tabbable cards can receive programmatic return focus. Never
			// restore the editor that happened to be active before right-click.
			const temporaryTabIndex = trigger.tabIndex < 0 && !trigger.hasAttribute('tabindex');
			if (temporaryTabIndex) trigger.setAttribute('tabindex', '-1');
			trigger.focus({ preventScroll: true });
			if (temporaryTabIndex) trigger.removeAttribute('tabindex');
		}
		updateOpen(false);
	}, [menuId, updateOpen]);

	// Context menus are rendered independently (for example, one per file-tree
	// row), so coordinate them through a document-level event. Opening one menu
	// closes any other menu and also clears its consumer's active state.
	React.useEffect(() => {
		const handleAnotherMenuOpen = (event: Event) => {
			const owner = (event as CustomEvent<object>).detail;
			if (owner !== ownerRef.current) close('replace');
		};
		document.addEventListener(CONTEXT_MENU_OPEN_EVENT, handleAnotherMenuOpen);
		return () => document.removeEventListener(CONTEXT_MENU_OPEN_EVENT, handleAnotherMenuOpen);
	}, [close]);

	const openAt = React.useCallback((x: number, y: number, trigger?: HTMLElement) => {
		document.dispatchEvent(new CustomEvent(CONTEXT_MENU_OPEN_EVENT, {
			detail: ownerRef.current,
		}));
		triggerRef.current = trigger ?? null;
		setPosition({ x, y });
		updateOpen(true);
	}, [updateOpen]);

	const setMenuOpen = React.useCallback((nextOpen: boolean) => {
		if (!nextOpen) close('select');
	}, [close]);

	return (
		<ContextMenuContext.Provider value={{ open, position, setOpen: setMenuOpen, openAt, triggerRef, menuId, close }}>
			{children}
		</ContextMenuContext.Provider>
	);
}

interface ContextMenuTriggerProps extends React.HTMLAttributes<HTMLDivElement> {
	asChild?: boolean;
}

// `ContextMenuTrigger` opens the web menu on right-click at the cursor's
// location. A child handler may handle the event first (for example by
// opening a macOS native menu); only an event that remains unhandled reaches
// the web-menu fallback below.
function ContextMenuTrigger({ children, className, onContextMenu, asChild, ...props }: ContextMenuTriggerProps) {
	const { openAt } = useContextMenuContext();

	const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		onContextMenu?.(e);
		if (e.defaultPrevented) return;
		e.preventDefault();
		e.stopPropagation();
		openAt(e.clientX, e.clientY, e.currentTarget);
	};

	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<ContextMenuTriggerChildProps>;
		return React.cloneElement(child, {
			onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => {
				child.props.onContextMenu?.(event as React.MouseEvent<HTMLElement>);
				handleContextMenu(event);
			},
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

function menuItems(menu: HTMLElement): HTMLElement[] {
	return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'))
		.filter((item) => item.closest('[role="menu"]') === menu
			&& !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true');
}

function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>) {
	if (event.defaultPrevented || !(event.target instanceof Element)
		|| event.target.closest('[role="menu"]') !== event.currentTarget) return;
	if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
	event.preventDefault();
	event.stopPropagation();
	const items = menuItems(event.currentTarget);
	if (!items.length) return;
	const current = items.indexOf(document.activeElement as HTMLElement);
	const index = event.key === 'Home' ? 0
		: event.key === 'End' ? items.length - 1
			: event.key === 'ArrowDown' ? (current + 1) % items.length
				: current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
	items[index].focus({ preventScroll: true });
}

function ContextMenuContent({ children, className, style }: ContextMenuContentProps) {
	const { open, position, triggerRef, menuId, close } = useContextMenuContext();
	const contentRef = React.useRef<HTMLDivElement>(null);
	React.useLayoutEffect(() => {
		if (open) contentRef.current?.focus({ preventScroll: true });
	}, [open, position]);

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
			if (target instanceof Element && target.closest("[data-flowix-menu-child]")) return;
			if (target instanceof Element && target.closest("[data-context-menu-submenu]")) return;
			close('outside');
		};

		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [open, close]);

	// Close on Escape, scroll, or resize.
	React.useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				close('escape');
			} else if (e.key === 'Tab') close('tab');
		};
		// A viewport-anchored menu only becomes stale when its trigger moves.
		// Sibling editor scrolling and scrolling inside the menu cannot dismiss
		// an in-flight pointer gesture before the menu item's click runs.
		const handleScroll = (e: Event) => {
			const target = e.target;
			const trigger = triggerRef.current;
			if (target instanceof Element && target.closest('[data-no-context-menu-scroll]')) return;
			if (target === document || target === window
				|| (target instanceof Element && trigger && target.contains(trigger))) close('scroll');
		};
		const handleResize = () => close('resize');

		document.addEventListener("keydown", handleKeyDown);
		window.addEventListener("scroll", handleScroll, true);
		window.addEventListener("resize", handleResize);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("scroll", handleScroll, true);
			window.removeEventListener("resize", handleResize);
		};
	}, [open, close, triggerRef]);

	if (!open) return null;
	if (typeof document === "undefined") return null;

	return createPortal(
		<div
			ref={contentRef}
			role="menu"
			tabIndex={-1}
			data-context-menu-owner={menuId}
			data-flowix-surface="context-menu"
			onKeyDown={navigateMenu}
			onPointerDown={(event) => event.stopPropagation()}
			onMouseDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onFocus={(event) => event.stopPropagation()}
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
	onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
	onSelect?: () => void;
	disabled?: boolean;
	inset?: boolean;
	keepOpenOnClick?: boolean;
	/** Native tooltip; use it to explain why a disabled row cannot be used. */
	title?: string;
}

function ContextMenuItem({
	"aria-describedby": ariaDescribedBy,
	children,
	className,
	onClick,
	onSelect,
	disabled,
	inset,
	keepOpenOnClick = false,
	title,
}: ContextMenuItemProps) {
	const { setOpen } = useContextMenuContext();

	const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		if (disabled) return;
		onClick?.(e);
		onSelect?.();
		if (!keepOpenOnClick) setOpen(false);
	};

	return (
		<button
			type="button"
			role="menuitem"
			tabIndex={-1}
			aria-describedby={ariaDescribedBy}
			disabled={disabled}
			title={title}
			onClick={handleClick}
			onMouseDown={(e) => {
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

function ContextMenuSubmenu({
	label,
	icon,
	children,
	disabled = false,
	title,
}: {
	label: React.ReactNode;
	icon?: React.ReactNode;
	children: React.ReactNode;
	disabled?: boolean;
	title?: string;
}) {
	const { menuId } = useContextMenuContext();
	const [open, setOpen] = React.useState(false);
	const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);
	const triggerRef = React.useRef<HTMLButtonElement | null>(null);
	const submenuRef = React.useRef<HTMLDivElement | null>(null);
	const skipFocusOpenRef = React.useRef(false);
	const focusFirstOnOpenRef = React.useRef(false);
	const closeTimerRef = React.useRef<number | null>(null);

	const cancelClose = () => {
		if (closeTimerRef.current === null) return;
		window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	};
	const scheduleClose = () => {
		cancelClose();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, 160);
	};
	React.useEffect(() => () => cancelClose(), []);
	React.useLayoutEffect(() => {
		if (!open || !focusFirstOnOpenRef.current || !submenuRef.current) return;
		focusFirstOnOpenRef.current = false;
		menuItems(submenuRef.current)[0]?.focus({ preventScroll: true });
	}, [open]);

	const alignToTrigger = React.useCallback((trigger: HTMLButtonElement) => {
		const rect = trigger.getBoundingClientRect();
		const width = Math.min(176, Math.max(0, window.innerWidth - 8));
		const submenu = submenuRef.current;
		const maxHeight = Math.max(0, window.innerHeight - 8);
		if (submenu) {
			submenu.style.width = `${width}px`;
			submenu.style.maxWidth = `${width}px`;
			submenu.style.maxHeight = `${maxHeight}px`;
			submenu.style.overflowY = 'auto';
		}
		const height = Math.min(submenu?.scrollHeight ?? 220, maxHeight);
		const left = window.innerWidth - rect.right < width + 4
			? Math.max(4, rect.left - width)
			: Math.min(rect.right, window.innerWidth - width - 4);
		const top = Math.max(4, Math.min(rect.top, window.innerHeight - height - 4));
		setPosition((current) => current?.left === left && current.top === top ? current : { left, top });
	}, []);
	const show = (trigger: HTMLButtonElement) => {
		cancelClose();
		triggerRef.current = trigger;
		alignToTrigger(trigger);
		setOpen(true);
	};

	// The parent context menu scales in when opened. Keep the submenu anchored
	// to the item until that animation finishes, including viewport clamping.
	React.useLayoutEffect(() => {
		if (!open) return;
		let frame = 0;
		const started = performance.now();
		const align = (now: number) => {
			if (triggerRef.current) alignToTrigger(triggerRef.current);
			if (now - started < 250) frame = window.requestAnimationFrame(align);
		};
		frame = window.requestAnimationFrame(align);
		return () => window.cancelAnimationFrame(frame);
	}, [alignToTrigger, open]);

	return (
		<div className="relative" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
			<button
				type="button"
				role="menuitem"
				tabIndex={-1}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				title={title}
				onMouseEnter={(event) => { if (!disabled) show(event.currentTarget); }}
				onFocus={(event) => {
					if (disabled) return;
					if (skipFocusOpenRef.current) {
						skipFocusOpenRef.current = false;
						return;
					}
					show(event.currentTarget);
				}}
				onClick={(event) => { event.stopPropagation(); if (!disabled) show(event.currentTarget); }}
				onKeyDown={(event) => {
					if (disabled) return;
					if (event.key === "ArrowRight") {
						event.preventDefault();
						event.stopPropagation();
						focusFirstOnOpenRef.current = true;
						show(event.currentTarget);
						if (submenuRef.current) {
							focusFirstOnOpenRef.current = false;
							menuItems(submenuRef.current)[0]?.focus({ preventScroll: true });
						}
					}
				}}
				onMouseDown={(event) => event.stopPropagation()}
				className="flex h-7 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] focus-visible:bg-[var(--brand)] focus-visible:text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--foreground)]"
			>
				<span className="flex min-w-0 items-center gap-2">{icon}{label}</span>
				<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
			{open && position && !disabled && createPortal(
				<div
					ref={submenuRef}
					data-context-menu-submenu="true"
					data-context-menu-owner={menuId}
					role="menu"
					onPointerDown={(event) => event.stopPropagation()}
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
					onFocus={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						if (event.key !== 'ArrowLeft' && event.key !== 'Escape') {
							navigateMenu(event);
							return;
						}
						event.preventDefault();
						event.stopPropagation();
						setOpen(false);
						skipFocusOpenRef.current = true;
						triggerRef.current?.focus({ preventScroll: true });
					}}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
					className="fixed z-[151] w-[176px] space-y-0.5 rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
					style={position}
				>
					{children}
				</div>,
				document.body,
			)}
		</div>
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
	return <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />;
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
	ContextMenuSubmenu,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuContext,
	useContextMenuContext,
};
