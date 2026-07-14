import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// Context for managing popover state
interface PopoverContextValue {
	open: boolean;
	setOpen: (open: boolean) => void;
	triggerRef: React.RefObject<HTMLElement | null>;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopoverContext() {
	const context = React.useContext(PopoverContext);
	if (!context) {
		throw new Error("Popover components must be used within Popover");
	}
	return context;
}

interface PopoverProps {
	children: React.ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

function Popover({ children, open: controlledOpen, onOpenChange }: PopoverProps) {
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
		<PopoverContext.Provider value={{ open, setOpen, triggerRef }}>
			<div className="relative">{children}</div>
		</PopoverContext.Provider>
	);
}

interface PopoverTriggerProps {
	children?: React.ReactNode;
	asChild?: boolean;
	className?: string;
	render?: React.ReactNode;
}

function PopoverTrigger({ children, asChild, className, render }: PopoverTriggerProps) {
	const { open, setOpen, triggerRef } = usePopoverContext();

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		setOpen(!open);
	};

	// Support render prop pattern like shadcn
	if (render) {
		const renderElement = render as React.ReactElement<any>;
		return React.cloneElement(renderElement, {
			ref: (el: HTMLElement | null) => {
				triggerRef.current = el;
			},
			onClick: handleClick,
			"data-state": open ? "open" : "closed",
		});
	}

	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<any>;
		return React.cloneElement(child, {
			ref: (el: HTMLElement | null) => {
				triggerRef.current = el;
			},
			onClick: handleClick,
			"data-state": open ? "open" : "closed",
		});
	}

	return (
		<div
			ref={triggerRef as React.LegacyRef<HTMLDivElement>}
			onClick={handleClick}
			className={cn("cursor-pointer", className)}
			data-state={open ? "open" : "closed"}
		>
			{children}
		</div>
	);
}

interface PopoverContentProps {
	children: React.ReactNode;
	align?: "start" | "center" | "end";
	side?: "top" | "right" | "bottom" | "left";
	sideOffset?: number;
	className?: string;
}

function PopoverContent({
	children,
	align = "end",
	side = "bottom",
	sideOffset = 4,
	className,
}: PopoverContentProps) {
	const { open, setOpen, triggerRef } = usePopoverContext();
	const contentRef = React.useRef<HTMLDivElement>(null);
	const [position, setPosition] = React.useState({ top: 0, left: 0 });

	// Calculate position when opened
	React.useEffect(() => {
		if (!open || !triggerRef.current) return;

		let rafId: number;

		const updatePosition = () => {
			const rect = triggerRef.current!.getBoundingClientRect();
			const width = contentRef.current?.offsetWidth ?? 200;
			const height = contentRef.current?.offsetHeight ?? 200;

			let topPos: number;
			let leftPos: number;

			if (side === "right" || side === "left") {
				leftPos = side === "right" ? rect.right + sideOffset : rect.left - width - sideOffset;
				topPos = align === "center"
					? rect.top + rect.height / 2 - height / 2
					: align === "end"
						? rect.bottom - height
						: rect.top;
			} else {
				topPos = side === "top" ? rect.top - height - sideOffset : rect.bottom + sideOffset;
				leftPos = align === "center"
					? rect.left + rect.width / 2 - width / 2
					: align === "end"
						? rect.right - width
						: rect.left;
			}

			setPosition({
				top: Math.max(4, Math.min(topPos, window.innerHeight - height - 4)),
				left: Math.max(4, Math.min(leftPos, window.innerWidth - width - 4)),
			});
		};

		rafId = requestAnimationFrame(updatePosition);
		setTimeout(updatePosition, 50);

		window.addEventListener('scroll', updatePosition, true);
		window.addEventListener('resize', updatePosition);

		return () => {
			cancelAnimationFrame(rafId);
			window.removeEventListener('scroll', updatePosition, true);
			window.removeEventListener('resize', updatePosition);
		};
	}, [open, side, sideOffset, align]);

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

			if (contentRef.current) {
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
	if (typeof document === "undefined") return null;

	// 一律走 shadow-lg。 之前 top 侧走
	// `shadow-[0_-2px_10px_rgba(0,0,0,0.1)]` 是为了"只投阴影到下方"避免
	// 浮在输入框之上时显得太突兀, 但用户反馈一级 / 二级阴影不一致, 视觉
	// 上像两个不同组件 ── 统一阴影让它们看起来是同一组件的两栏。
	const shadowClass = "shadow-lg";

	return createPortal(
		<div
			ref={contentRef}
			className={cn(
				"fixed z-[1500] w-[200px] bg-[var(--card)] border border-[var(--border)] rounded-lg p-1 animate-in fade-in-0 zoom-in-95",
				shadowClass,
				className
			)}
			style={{
				top: position.top,
				left: position.left,
			}}
			onClick={(e) => e.stopPropagation()}
		>
			{children}
		</div>,
		document.body
	);
}

export { Popover, PopoverTrigger, PopoverContent };
