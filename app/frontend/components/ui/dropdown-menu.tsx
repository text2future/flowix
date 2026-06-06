import * as React from "react";
import { cn } from "../../lib/utils";

// Context for managing dropdown state
interface DropdownMenuContextValue {
	open: boolean;
	setOpen: (open: boolean) => void;
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

function DropdownMenu({ children, open: controlledOpen, onOpenChange }: DropdownMenuProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
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
		<DropdownMenuContext.Provider value={{ open, setOpen }}>
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
	const { open, setOpen } = useDropdownContext();

	const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		setOpen(!open);
		props.onClick?.(e);
	};

	// If asChild, expect a single child element that we can clone with merged props
	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<any>;
		return React.cloneElement(child, {
			onClick: handleClick,
			'data-state': open ? 'open' : 'closed',
		} as Record<string, unknown>);
	}

	return (
		<button
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
}: {
	children: React.ReactNode;
	align?: "start" | "center" | "end";
	side?: "top" | "bottom";
	sideOffset?: number;
	className?: string;
	style?: React.CSSProperties;
}) {
	const { open, setOpen } = useDropdownContext();
	const contentRef = React.useRef<HTMLDivElement>(null);

	// Close on click outside
	React.useEffect(() => {
		if (!open) return;

		const handleClickOutside = (e: MouseEvent) => {
			if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open, setOpen]);

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

	const alignClass = {
		start: "left-0",
		center: "left-1/2 -translate-x-1/2",
		end: "right-0",
	};

	const sideStyle = side === "top"
		? { bottom: "100%", marginBottom: sideOffset }
		: { top: "100%", marginTop: sideOffset };

	return (
		<div
			ref={contentRef}
			className={cn(
				"absolute z-50 min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1 animate-in fade-in-0 zoom-in-95",
				alignClass[align],
				className
			)}
			style={{ ...sideStyle, ...style }}
		>
			{children}
		</div>
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
				<div className="absolute left-full ml-1 top-0 z-50 min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1">
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
				"absolute left-full ml-1 top-0 z-50 min-w-[160px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1",
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