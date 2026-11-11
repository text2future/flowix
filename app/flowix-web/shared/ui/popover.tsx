import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { consumeCellPopupTriggerClick } from "@shared/ui/consume-cell-popup-click";

// Context for managing popover state
interface PopoverContextValue {
	parent: PopoverContextValue | null;
	descendantContents: React.RefObject<Set<HTMLElement>>;
	open: boolean;
	setOpen: (open: boolean) => void;
	triggerRef: React.RefObject<HTMLElement | null>;
	anchorRect: DOMRect | null;
	setTriggerAnchorRect: (rect: DOMRect | null) => void;
	cellAnchorRect: DOMRect | null;
	setCellAnchorRect: (rect: DOMRect | null) => void;
	cellPopup: boolean;
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
	anchorElement?: HTMLElement | null;
	anchorRect?: DOMRect | null;
	cellPopup?: boolean;
}

function Popover({ children, open: controlledOpen, onOpenChange, anchorElement = null, anchorRect = null, cellPopup = false }: PopoverProps) {
	const parent = React.useContext(PopoverContext);
	const descendantContents = React.useRef(new Set<HTMLElement>());
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLElement>(null);
	const [triggerAnchorRect, setTriggerAnchorRect] = React.useState<DOMRect | null>(null);
	const [cellAnchorRect, setCellAnchorRect] = React.useState<DOMRect | null>(null);
	if (anchorElement) triggerRef.current = anchorElement;
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
		<PopoverContext.Provider value={{ parent, descendantContents, open, setOpen, triggerRef, anchorRect: triggerAnchorRect ?? anchorRect, setTriggerAnchorRect, cellAnchorRect, setCellAnchorRect, cellPopup }}>
			<div className="relative">{children}</div>
		</PopoverContext.Provider>
	);
}

interface PopoverTriggerProps {
	children?: React.ReactNode;
	asChild?: boolean;
	className?: string;
	render?: React.ReactNode;
	anchorToCell?: boolean;
	disabled?: boolean;
}

interface PopoverTriggerChildProps {
	ref?: React.Ref<HTMLElement>;
	onClick?: React.MouseEventHandler<HTMLElement>;
	"data-state"?: "open" | "closed";
	"data-flowix-cell-popup-trigger"?: "true";
	"aria-disabled"?: boolean;
}

function PopoverTrigger({ children, asChild, className, render, anchorToCell = false, disabled = false }: PopoverTriggerProps) {
	const { open, setOpen, triggerRef, setTriggerAnchorRect, setCellAnchorRect, cellPopup } = usePopoverContext();

	React.useLayoutEffect(() => {
		if (!anchorToCell || !open) return;
		const trigger = triggerRef.current;
		const cell = trigger?.closest("td") ?? trigger?.closest<HTMLElement>("[data-flowix-cell-anchor]");
		const rect = cell?.getBoundingClientRect() ?? trigger?.getBoundingClientRect();
		if (rect) setCellAnchorRect(rect);
	}, [anchorToCell, open, setCellAnchorRect, triggerRef]);

	const handleClick = (e: React.MouseEvent) => {
		if (disabled) return;
		if (anchorToCell) {
			const cell = e.currentTarget.closest("td") ?? e.currentTarget.closest<HTMLElement>("[data-flowix-cell-anchor]");
			const rect = cell?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect();
			setTriggerAnchorRect(rect);
			setCellAnchorRect(rect);
		}
		e.stopPropagation();
		setOpen(!open);
	};

	// Support render prop pattern like shadcn
	if (React.isValidElement<PopoverTriggerChildProps>(render)) {
		const renderElement = render;
		return React.cloneElement(renderElement, {
			ref: (el: HTMLElement | null) => {
				triggerRef.current = el;
			},
			onClick: handleClick,
			"data-state": open ? "open" : "closed",
			"data-flowix-cell-popup-trigger": cellPopup || anchorToCell ? "true" : undefined,
			"aria-disabled": disabled || undefined,
		});
	}

	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<PopoverTriggerChildProps>;
		return React.cloneElement(child, {
			ref: (el: HTMLElement | null) => {
				triggerRef.current = el;
			},
			onClick: handleClick,
			"data-state": open ? "open" : "closed",
			"data-flowix-cell-popup-trigger": cellPopup || anchorToCell ? "true" : undefined,
			"aria-disabled": disabled || undefined,
		});
	}

	return (
		<div
			ref={triggerRef as React.LegacyRef<HTMLDivElement>}
			onClick={handleClick}
			className={cn("cursor-pointer", className)}
			data-state={open ? "open" : "closed"}
			data-flowix-cell-popup-trigger={cellPopup || anchorToCell ? "true" : undefined}
		>
			{children}
		</div>
	);
}

interface PopoverContentProps {
	children: React.ReactNode;
	anchorSelector?: string;
	align?: "start" | "center" | "end";
	side?: "top" | "right" | "bottom" | "left";
	sideOffset?: number;
	offsetY?: number;
	className?: string;
	"aria-label"?: string;
	style?: React.CSSProperties;
	onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
	onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
	matchAnchorWidth?: boolean | number;
	matchAnchorHeight?: boolean | number;
	onExitComplete?: () => void;
	ignoreSelectOutside?: boolean;
	ignorePopoverOutside?: boolean;
	fitViewport?: boolean;
	alignToAnchorOrigin?: boolean;
	keepParentMenuOpen?: boolean;
}

type PopoverMotionState = "starting" | "open" | "closing";

const EXIT_ANIMATION_FALLBACK_MS = 500;

function PopoverContent({
	children,
	anchorSelector,
	align = "end",
	side = "bottom",
	sideOffset = 4,
	offsetY = 0,
	className,
	"aria-label": ariaLabel,
	style,
	onMouseEnter,
	onMouseLeave,
	matchAnchorWidth = false,
	matchAnchorHeight = false,
	onExitComplete,
	ignoreSelectOutside = true,
	ignorePopoverOutside = false,
	fitViewport = false,
	alignToAnchorOrigin = false,
	keepParentMenuOpen = false,
}: PopoverContentProps) {
	const { parent, descendantContents, open, setOpen, triggerRef, anchorRect, cellAnchorRect, cellPopup } = usePopoverContext();
	const contentRef = React.useRef<HTMLDivElement>(null);
	const [position, setPosition] = React.useState({ top: 0, left: 0 });
	const [present, setPresent] = React.useState(open);
	const [motionState, setMotionState] = React.useState<PopoverMotionState>("starting");
	const onExitCompleteRef = React.useRef(onExitComplete);
	onExitCompleteRef.current = onExitComplete;

	const finishClose = React.useCallback(() => {
		setPresent(false);
		onExitCompleteRef.current?.();
	}, []);

	// Keep the portal mounted while the closing animation runs. Reopening during
	// that window reverses the lifecycle without tearing down the content node.
	React.useLayoutEffect(() => {
		if (open) {
			if (!present) {
				setMotionState("starting");
				setPresent(true);
			} else if (motionState === "closing") {
				setMotionState("starting");
			}
			return;
		}

		if (!present) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			finishClose();
			return;
		}

		setMotionState("closing");
		const fallbackId = window.setTimeout(() => {
			finishClose();
		}, EXIT_ANIMATION_FALLBACK_MS);
		return () => window.clearTimeout(fallbackId);
	}, [finishClose, motionState, open, present]);

	// Position the invisible starting frame before paint, then enter next frame.
	React.useLayoutEffect(() => {
			if (!open || !present || (!cellAnchorRect && !anchorRect && !triggerRef.current)) return;

		let rafId: number;
		let settleTimerId: number;

		const updatePosition = () => {
			const content = contentRef.current;
			const trigger = triggerRef.current;
			const anchor = anchorSelector ? trigger?.closest<HTMLElement>(anchorSelector) : null;
			const rect = anchor?.getBoundingClientRect() ?? cellAnchorRect ?? anchorRect ?? trigger?.getBoundingClientRect();
			if (!rect) return;
			if (content && alignToAnchorOrigin) {
				content.style.maxWidth = `${Math.max(0, window.innerWidth - rect.left - 4)}px`;
				content.style.maxHeight = `${Math.max(0, window.innerHeight - rect.top - 4)}px`;
				content.style.overflowY = 'auto';
			} else if (fitViewport && content) {
				content.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
				content.style.maxHeight = `${Math.max(0, window.innerHeight - 8)}px`;
				content.style.overflowY = 'auto';
			}
			const width = contentRef.current?.offsetWidth ?? 200;
			const height = contentRef.current?.offsetHeight ?? 200;

			let topPos: number;
			let leftPos: number;

			let resolvedSide = side;
			if (side === 'right' && rect.right + width + sideOffset > window.innerWidth - 4 && rect.left - width - sideOffset >= 4) {
				resolvedSide = 'left';
			} else if (side === 'left' && rect.left - width - sideOffset < 4 && rect.right + width + sideOffset <= window.innerWidth - 4) {
				resolvedSide = 'right';
			} else if (side === 'bottom' && rect.bottom + height + sideOffset > window.innerHeight - 4 && rect.top - height - sideOffset >= 4) {
				resolvedSide = 'top';
			} else if (side === 'top' && rect.top - height - sideOffset < 4 && rect.bottom + height + sideOffset <= window.innerHeight - 4) {
				resolvedSide = 'bottom';
			}

			if (alignToAnchorOrigin) {
				leftPos = rect.left;
				topPos = rect.top;
			} else if (cellAnchorRect) {
				leftPos = rect.left;
				topPos = rect.top;
			} else if (resolvedSide === "right" || resolvedSide === "left") {
				leftPos = resolvedSide === "right" ? rect.right + sideOffset : rect.left - width - sideOffset;
				topPos = align === "center"
					? rect.top + rect.height / 2 - height / 2
					: align === "end"
						? rect.bottom - height
						: rect.top;
			} else {
				topPos = resolvedSide === "top" ? rect.top - height - sideOffset : rect.bottom + sideOffset;
				leftPos = align === "center"
					? rect.left + rect.width / 2 - width / 2
					: align === "end"
						? rect.right - width
						: rect.left;
			}

			topPos += offsetY;
			const nextPosition = alignToAnchorOrigin
				? { top: topPos, left: leftPos }
				: {
					top: Math.max(4, Math.min(topPos, window.innerHeight - height - 4)),
					left: Math.max(4, Math.min(leftPos, window.innerWidth - width - 4)),
				};
			setPosition((current) =>
				current.top === nextPosition.top && current.left === nextPosition.left
					? current
					: nextPosition
			);
		};

		updatePosition();
		rafId = requestAnimationFrame(() => setMotionState("open"));
		settleTimerId = window.setTimeout(updatePosition, 50);
		const resizeObserver = fitViewport && typeof ResizeObserver !== 'undefined' && contentRef.current
			? new ResizeObserver(updatePosition)
			: null;
		if (contentRef.current) resizeObserver?.observe(contentRef.current);

		window.addEventListener('scroll', updatePosition, true);
		window.addEventListener('resize', updatePosition);

		return () => {
			cancelAnimationFrame(rafId);
			window.clearTimeout(settleTimerId);
			resizeObserver?.disconnect();
			window.removeEventListener('scroll', updatePosition, true);
			window.removeEventListener('resize', updatePosition);
		};
	}, [open, present, side, sideOffset, offsetY, align, anchorRect, cellAnchorRect, anchorSelector, fitViewport, alignToAnchorOrigin]);

	React.useEffect(() => {
		if (!open || !cellAnchorRect) return;
		const closeOnTableScroll = () => setOpen(false);
		window.addEventListener("flowix:multidimensional-table-scroll", closeOnTableScroll);
		return () => window.removeEventListener("flowix:multidimensional-table-scroll", closeOnTableScroll);
	}, [open, cellAnchorRect, setOpen]);

	// Portaled child content is outside the parent's DOM subtree, but still
	// belongs to the same interaction. Register it with each ancestor popover.
	React.useEffect(() => {
		const content = contentRef.current;
		if (!open || !content) return;
		const ancestors: PopoverContextValue[] = [];
		for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
			ancestor.descendantContents.current.add(content);
			ancestors.push(ancestor);
		}
		return () => {
			for (const ancestor of ancestors) ancestor.descendantContents.current.delete(content);
		};
	}, [open, present, parent]);

	// Close on pointerdown outside. Capture matches DropdownMenu's behavior and
	// makes the close reliable when an ancestor stops propagation (for example
	// the native drag-region handling in the desktop title bar).
	React.useEffect(() => {
		if (!open) return;

		const handlePointerDownOutside = (e: PointerEvent) => {
			const target = e.target as Node;
			if (
				contentRef.current?.contains(target) ||
				[...descendantContents.current].some((content) => content.contains(target)) ||
				triggerRef.current?.contains(target) ||
				(ignoreSelectOutside && target instanceof Element && target.closest('[data-flowix-surface="select"]')) ||
				(ignorePopoverOutside && target instanceof Element && target.closest('[data-flowix-surface="popover"]'))
			) {
				return;
			}

			if (contentRef.current) {
				if (cellPopup) consumeCellPopupTriggerClick(e);
				setOpen(false);
			}
		};

		document.addEventListener("pointerdown", handlePointerDownOutside, true);
		return () => document.removeEventListener("pointerdown", handlePointerDownOutside, true);
	}, [open, setOpen, anchorRect, cellPopup, ignoreSelectOutside, ignorePopoverOutside, descendantContents]);

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

	if (!present) return null;
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
				"flowix-popover-content fixed z-[var(--layer-popover)] w-[200px] bg-[var(--card)] border border-[var(--border-popup)] rounded-lg p-1",
				shadowClass,
				className
			)}
			data-motion-state={motionState}
			data-side={side}
				data-flowix-surface="popover"
			data-flowix-menu-child={keepParentMenuOpen ? "" : undefined}
			role={ariaLabel ? "dialog" : undefined}
			aria-label={ariaLabel}
			style={{
				...style,
				...(matchAnchorWidth && cellAnchorRect
					? { width: cellAnchorRect.width * (typeof matchAnchorWidth === "number" ? matchAnchorWidth : 1) }
					: {}),
				...(matchAnchorHeight && cellAnchorRect
					? { minHeight: cellAnchorRect.height * (typeof matchAnchorHeight === "number" ? matchAnchorHeight : 1) }
					: {}),
				top: position.top,
				left: position.left,
			}}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			onClick={(e) => e.stopPropagation()}
			onAnimationEnd={(event) => {
				if (event.target === event.currentTarget && motionState === "closing") {
					finishClose();
				}
			}}
		>
			{children}
		</div>,
		document.body
	);
}

export { Popover, PopoverTrigger, PopoverContent };
