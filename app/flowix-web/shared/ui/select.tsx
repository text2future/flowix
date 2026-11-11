import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { consumeCellPopupTriggerClick } from "@shared/ui/consume-cell-popup-click";

interface SelectTriggerChildProps extends React.HTMLAttributes<HTMLElement> {
	disabled?: boolean;
}
import { ChevronDown, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";

// Context for managing select state
interface SelectContextValue {
	value: string;
	onValueChange: (value: string) => void;
	open: boolean;
	disabled: boolean;
	setOpen: (open: boolean) => void;
	triggerRef: React.RefObject<HTMLElement | null>;
	anchorRect: DOMRect | null;
	setAnchorRect: (rect: DOMRect | null) => void;
	anchorToCell: boolean;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);
const selectDisabledClassName = "disabled:cursor-not-allowed disabled:opacity-50";

function useSelectContext() {
	const context = React.useContext(SelectContext);
	if (!context) {
		throw new Error("Select components must be used within Select");
	}
	return context;
}

interface SelectProps {
	children: React.ReactNode;
	value?: string;
	onValueChange?: (value: string) => void;
	defaultValue?: string;
	disabled?: boolean;
	anchorToCell?: boolean;
}

function Select({ children, value: controlledValue, onValueChange, defaultValue = "", disabled = false, anchorToCell = false }: SelectProps) {
	const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLElement | null>(null);
	const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);

	const value = controlledValue !== undefined ? controlledValue : uncontrolledValue;
	const open = disabled ? false : uncontrolledOpen;
	React.useEffect(() => {
		if (disabled) setUncontrolledOpen(false);
	}, [disabled]);

	const setOpen = React.useCallback(
		(newOpen: boolean) => {
			if (disabled) return;
			setUncontrolledOpen(newOpen);
		},
		[disabled]
	);

	const handleValueChange = React.useCallback(
		(newValue: string) => {
			if (disabled) return;
			if (controlledValue === undefined) {
				setUncontrolledValue(newValue);
			}
			onValueChange?.(newValue);
			setOpen(false);
		},
		[controlledValue, disabled, onValueChange, setOpen]
	);

	return (
		<SelectContext.Provider value={{ value, onValueChange: handleValueChange, open, disabled, setOpen, triggerRef, anchorRect, setAnchorRect, anchorToCell }}>
			<div className="relative">{children}</div>
		</SelectContext.Provider>
	);
}

interface SelectTriggerProps {
	children?: React.ReactNode;
	className?: string;
	asChild?: boolean;
	id?: string;
	'aria-label'?: string;
	'aria-labelledby'?: string;
	'aria-describedby'?: string;
}

function SelectTrigger({ children, className, asChild, id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy }: SelectTriggerProps) {
	const { value, open, disabled, setOpen, triggerRef, setAnchorRect, anchorToCell } = useSelectContext();
	const { t } = useI18n();

	const handleClick = (event: React.MouseEvent<HTMLElement>) => {
		if (disabled) return;
		if (anchorToCell) {
			const cell = event.currentTarget.closest("td");
			setAnchorRect(cell?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect());
		}
		setOpen(!open);
	};

	// If no children, render a default trigger with current value
	if (!children) {
		return (
			<button
				type="button"
				ref={triggerRef as React.Ref<HTMLButtonElement>}
				id={id}
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				aria-describedby={ariaDescribedBy}
				disabled={disabled}
				onClick={handleClick}
				className={cn(
					"flex items-center justify-between w-full h-8 px-3 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]",
					selectDisabledClassName,
					className
				)}
				data-state={open ? "open" : "closed"}
				data-flowix-cell-popup-trigger={anchorToCell ? "true" : undefined}
			>
				<span className={value ? "" : "text-[var(--muted-foreground)]"}>
					{value || t("common.pleaseSelect")}
				</span>
				<ChevronDown className={cn("w-4 h-4 transition-transform", open && "rotate-180")} />
			</button>
		);
	}

	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<SelectTriggerChildProps>;
		const childOnClick = child.props.onClick;
		return React.cloneElement(child, {
			ref: triggerRef,
			id: id ?? child.props.id,
			'aria-label': ariaLabel ?? child.props['aria-label'],
			'aria-labelledby': ariaLabelledBy ?? child.props['aria-labelledby'],
			'aria-describedby': ariaDescribedBy ?? child.props['aria-describedby'],
			className: cn(child.props.className, className, selectDisabledClassName),
			onClick: (event: React.MouseEvent<HTMLElement>) => {
				if (disabled) return;
				childOnClick?.(event);
				if (!event.defaultPrevented) handleClick(event);
			},
			'data-state': open ? 'open' : 'closed',
			disabled: disabled || Boolean(child.props.disabled),
			'data-flowix-cell-popup-trigger': anchorToCell ? 'true' : undefined,
		} as Record<string, unknown>);
	}

	return (
		<button
			type="button"
			ref={triggerRef as React.Ref<HTMLButtonElement>}
			id={id}
			aria-label={ariaLabel}
			aria-labelledby={ariaLabelledBy}
			aria-describedby={ariaDescribedBy}
			disabled={disabled}
			onClick={handleClick}
			className={cn(
				"flex items-center justify-between w-full h-8 px-3 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]",
				selectDisabledClassName,
				className
			)}
			data-state={open ? "open" : "closed"}
			data-flowix-cell-popup-trigger={anchorToCell ? "true" : undefined}
		>
			{children}
			<ChevronDown className={cn("w-4 h-4 transition-transform", open && "rotate-180")} />
		</button>
	);
}

interface SelectValueProps {
	children?: React.ReactNode;
	placeholder?: string;
}

function SelectValue({ children, placeholder }: SelectValueProps) {
	const { value } = useSelectContext();

	if (children) return <>{children}</>;

	const displayValue = !value || value === "0" ? placeholder : value;
	return <span className={displayValue ? "" : "text-[var(--muted-foreground)]"}>{displayValue}</span>;
}

interface SelectContentProps {
	children: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
	align?: "start" | "center" | "end";
	/** Keep an enclosing dropdown menu open while this portal is interacted with. */
	keepParentMenuOpen?: boolean;
	/** Keep the menu inside the viewport and scroll its items when necessary. */
	fitViewport?: boolean;
	/** Prefer scrolling below the trigger; flip above only when below cannot fit a short menu. */
	preferBelow?: boolean;
	/** Optional maximum popup height in pixels or viewport height when fitViewport is enabled. */
	maxHeight?: number | `${number}vh`;
	matchAnchorWidth?: boolean | number;
	autoFocusInput?: boolean;
	closeOnEnter?: boolean;
}

function SelectContent({
	children,
	className,
	style,
	align = "end",
	keepParentMenuOpen = false,
	fitViewport = false,
	preferBelow = false,
	maxHeight,
	matchAnchorWidth = false,
	autoFocusInput = false,
	closeOnEnter = false,
}: SelectContentProps) {
	const { open, setOpen, triggerRef, anchorRect, anchorToCell } = useSelectContext();
	const contentRef = React.useRef<HTMLDivElement>(null);
	const scrollTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const [position, setPosition] = React.useState<React.CSSProperties | null>(null);
	const [isScrolling, setIsScrolling] = React.useState(false);

	React.useEffect(() => () => {
		if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
	}, []);

	const handleScroll = () => {
		setIsScrolling(true);
		if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
		scrollTimeoutRef.current = setTimeout(() => {
			setIsScrolling(false);
			scrollTimeoutRef.current = null;
		}, 700);
	};

	React.useLayoutEffect(() => {
		if (!open) return;
		const trigger = triggerRef.current;
		if (!trigger) return;

		const updatePosition = () => {
			const rect = anchorRect ?? trigger.getBoundingClientRect();
			const gap = 4;
			const viewportPadding = 8;
			const viewportWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
			const nextPosition: React.CSSProperties = {
				position: "fixed",
				top: anchorToCell ? rect.top : rect.bottom + gap,
				minWidth: rect.width,
			};

			if (fitViewport && !anchorToCell) {
				const content = contentRef.current;
				nextPosition.minWidth = Math.min(rect.width, viewportWidth);
				nextPosition.maxWidth = viewportWidth;
				if (content) {
					content.style.position = "fixed";
					content.style.boxSizing = "border-box";
					content.style.minWidth = `${nextPosition.minWidth}px`;
					content.style.maxWidth = `${viewportWidth}px`;
				}
				const availableBelow = Math.max(
					0,
					window.innerHeight - rect.bottom - gap - viewportPadding,
				);
				const availableAbove = Math.max(0, rect.top - gap - viewportPadding);
				const maxHeightPixels = typeof maxHeight === "number"
					? maxHeight
					: maxHeight
						? window.innerHeight * Number.parseFloat(maxHeight) / 100
						: Number.POSITIVE_INFINITY;
				const preferredHeight = Math.min(
					maxHeightPixels,
					contentRef.current?.scrollHeight ?? Number.POSITIVE_INFINITY,
				);
				const requiredBelow = preferBelow ? Math.min(preferredHeight, 128) : preferredHeight;
				const openAbove = availableBelow < requiredBelow && availableAbove > availableBelow;
				const available = openAbove ? availableAbove : availableBelow;
				if (openAbove) {
					delete nextPosition.top;
					nextPosition.bottom = window.innerHeight - rect.top + gap;
				}
				nextPosition.maxHeight = `${Math.min(available, preferredHeight)}px`;
			}

			if (fitViewport && !anchorToCell) {
				const width = Math.min(contentRef.current?.offsetWidth ?? rect.width, viewportWidth);
				const alignedLeft = align === "center"
					? rect.left + (rect.width - width) / 2
					: align === "end" ? rect.right - width : rect.left;
				nextPosition.left = Math.max(viewportPadding, Math.min(alignedLeft, window.innerWidth - width - viewportPadding));
			} else if (anchorToCell || align === "start") {
				nextPosition.left = rect.left;
			} else if (align === "center") {
				nextPosition.left = rect.left + rect.width / 2;
				nextPosition.transform = "translateX(-50%)";
			} else {
				nextPosition.right = Math.max(8, window.innerWidth - rect.right);
			}

			setPosition(nextPosition);
		};

		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [align, anchorRect, anchorToCell, fitViewport, maxHeight, open, preferBelow, triggerRef]);

	React.useEffect(() => {
		if (!open || !anchorToCell) return;
		const closeOnTableScroll = () => setOpen(false);
		window.addEventListener("flowix:multidimensional-table-scroll", closeOnTableScroll);
		return () => window.removeEventListener("flowix:multidimensional-table-scroll", closeOnTableScroll);
	}, [open, anchorToCell, setOpen]);

	// Close on click outside
	React.useEffect(() => {
		if (!open) return;

		if (anchorToCell) {
			const handlePointerDownOutside = (event: PointerEvent) => {
				const target = event.target as Node;
				if (
					contentRef.current?.contains(target) ||
					triggerRef.current?.contains(target)
				) return;

				consumeCellPopupTriggerClick(event);
				setOpen(false);
			};
			document.addEventListener("pointerdown", handlePointerDownOutside, true);
			return () => document.removeEventListener("pointerdown", handlePointerDownOutside, true);
		}

		const handleMouseDownOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			if (
				contentRef.current &&
				!contentRef.current.contains(target) &&
				!triggerRef.current?.contains(target)
			) setOpen(false);
		};

		document.addEventListener("mousedown", handleMouseDownOutside);
		return () => document.removeEventListener("mousedown", handleMouseDownOutside);
	}, [open, setOpen, triggerRef, anchorToCell]);

	// Close on escape
	React.useLayoutEffect(() => {
		if (!open || !autoFocusInput) return;
		contentRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
	}, [autoFocusInput, open]);

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

	return createPortal(
		<div
			ref={contentRef}
			onKeyDown={(event) => {
				if (closeOnEnter && event.key === "Enter" && event.target instanceof HTMLInputElement) {
					event.preventDefault();
					setOpen(false);
				}
			}}
			onScroll={handleScroll}
			// `animate-in …` 是 tw-animate-css 的死类 (Tailwind v3 不生成),
			// 换成共享关键帧类; select 通常向下弹出, origin 取顶部。
			style={{
				transformOrigin: "top center",
				...position,
				...(matchAnchorWidth && anchorRect ? { width: anchorRect.width * (typeof matchAnchorWidth === "number" ? matchAnchorWidth : 1) } : {}),
				...style,
			}}
			className={cn(
				"z-[150] min-w-[180px] bg-[var(--card)] border border-[var(--border-popup)] rounded-lg shadow-lg px-1.5 py-2 flowix-popover-enter",
				fitViewport && "overflow-y-auto overscroll-contain [scrollbar-gutter:stable]",
				className
			)}
			data-flowix-surface="select"
			data-flowix-menu-child={keepParentMenuOpen ? "" : undefined}
			data-scrolling={isScrolling ? "true" : "false"}
		>
			{children}
		</div>,
		document.body
	);
}

interface SelectItemProps {
	children: React.ReactNode;
	value: string;
	className?: string;
}

function SelectItem({ children, value, className }: SelectItemProps) {
	const { value: selectedValue, onValueChange, disabled } = useSelectContext();
	const isSelected = selectedValue === value;

	const handleClick = () => {
		onValueChange(value);
	};

	return (
		<button
			type="button"
			disabled={disabled}
			onClick={handleClick}
			data-selected={isSelected ? "true" : "false"}
			className={cn(
				"flex min-h-8 items-center w-full gap-2 rounded-md px-2.5 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] cursor-pointer outline-none",
				className
			)}
		>
			<span className="flex-1 text-left">{children}</span>
			{isSelected && <Check className="w-4 h-4 text-[var(--brand)]" />}
		</button>
	);
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
