import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

// Context for managing context-menu state. Position is captured at the moment
// of the right-click, so the menu opens exactly at the cursor.
interface ContextMenuContextValue {
	open: boolean;
	position: { x: number; y: number } | null;
	setOpen: (open: boolean) => void;
	openAt: (x: number, y: number) => void;
}

const ContextMenuContext = React.createContext<ContextMenuContextValue | null>(null);

function useContextMenuContext() {
	const context = React.useContext(ContextMenuContext);
	if (!context) {
		throw new Error("ContextMenu components must be used within ContextMenu");
	}
	return context;
}

interface ContextMenuProps {
	children: React.ReactNode;
}

function ContextMenu({ children }: ContextMenuProps) {
	const [open, setOpen] = React.useState(false);
	const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);

	const openAt = React.useCallback((x: number, y: number) => {
		setPosition({ x, y });
		setOpen(true);
	}, []);

	const close = React.useCallback(() => {
		setOpen(false);
		// Keep the last position until the menu finishes its close animation; the
		// content is unmounted when open is false so position becomes invisible
		// to the user either way.
	}, []);

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
		const child = React.Children.only(children) as React.ReactElement<any>;
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

	// Clamp the position so the menu never spills off-screen. We measure the
	// content after the first paint (the menu mounts hidden, so we can't read
	// its dimensions synchronously).
	React.useLayoutEffect(() => {
		if (!open || !contentRef.current || !position) return;
		const el = contentRef.current;
		const rect = el.getBoundingClientRect();
		const margin = 4;
		const maxX = window.innerWidth - rect.width - margin;
		const maxY = window.innerHeight - rect.height - margin;
		const x = Math.max(margin, Math.min(position.x, maxX));
		const y = Math.max(margin, Math.min(position.y, maxY));
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
	}, [open, position]);

	// Close on any pointerdown outside the menu content.
	React.useEffect(() => {
		if (!open) return;

		const handlePointerDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (contentRef.current?.contains(target)) return;
			setOpen(false);
		};

		document.addEventListener("mousedown", handlePointerDown);
		return () => document.removeEventListener("mousedown", handlePointerDown);
	}, [open, setOpen]);

	// Close on Escape, scroll, or resize.
	React.useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		const handleScroll = () => setOpen(false);
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
				"fixed z-[1000] min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1 animate-in fade-in-0 zoom-in-95",
				className
			)}
		>
			{children}
		</div>,
		document.body
	);
}

interface ContextMenuItemProps {
	children: React.ReactNode;
	className?: string;
	onClick?: () => void;
	onSelect?: () => void;
	disabled?: boolean;
	inset?: boolean;
}

function ContextMenuItem({
	children,
	className,
	onClick,
	onSelect,
	disabled,
	inset,
}: ContextMenuItemProps) {
	const { setOpen } = useContextMenuContext();

	const handleClick = () => {
		if (disabled) return;
		onClick?.();
		onSelect?.();
		setOpen(false);
	};

	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={handleClick}
			onMouseDown={(e) => e.preventDefault()}
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
};
