import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

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
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

interface DropdownMenuContentProps {
	children: React.ReactNode;
	align?: DropdownAlign;
	side?: DropdownSide;
	sideOffset?: number;
	className?: string;
	style?: React.CSSProperties;
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

function DropdownMenu({ children, open: controlledOpen, onOpenChange }: DropdownMenuProps) {
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
			<div className="relative">{children}</div>
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
		const child = React.Children.only(children) as React.ReactElement<any>;
		return React.cloneElement(child, {
			ref: (el: HTMLElement | null) => {
				triggerRef.current = el;
				const childRef = (child as any).ref;
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
	React.useEffect(() => {
		if (!open) return;

		const handleClickOutside = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				contentRef.current?.contains(target) ||
				triggerRef.current?.contains(target)
			) {
				return;
			}

			setOpen(false);
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
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
			className={cn(
				"fixed z-[1000] min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1 animate-in fade-in-0 zoom-in-95",
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
	onClick,
	onMouseDown,
	inset,
}: {
	children: React.ReactNode;
	className?: string;
	onClick?: () => void;
	onMouseDown?: (e: React.MouseEvent) => void;
	inset?: boolean;
}) {
	const { setOpen } = useDropdownContext();

	const handleClick = () => {
		onClick?.();
		setOpen(false);
	};

	const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		onMouseDown?.(e);
	};

	return (
		<button
			onClick={handleClick}
			onMouseDown={handleMouseDown}
			className={cn(
				"flex items-center w-full px-3 py-1.5 text-sm text-[var(--foreground)] cursor-pointer outline-none",
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
				<div className="absolute left-full ml-1 top-0 z-[1000] min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1">
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
				"absolute left-full ml-1 top-0 z-[1000] min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1",
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
};
