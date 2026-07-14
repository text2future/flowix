import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { ChevronDown, Check } from "lucide-react";
import { useI18n } from "@features/i18n";

// Context for managing select state
interface SelectContextValue {
	value: string;
	onValueChange: (value: string) => void;
	open: boolean;
	setOpen: (open: boolean) => void;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);

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
}

function Select({ children, value: controlledValue, onValueChange, defaultValue = "", disabled = false }: SelectProps) {
	const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement | null>(null);

	const value = controlledValue !== undefined ? controlledValue : uncontrolledValue;
	const open = uncontrolledOpen;

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
		<SelectContext.Provider value={{ value, onValueChange: handleValueChange, open, setOpen, triggerRef }}>
			<div className="relative">{children}</div>
		</SelectContext.Provider>
	);
}

interface SelectTriggerProps {
	children?: React.ReactNode;
	className?: string;
	asChild?: boolean;
}

function SelectTrigger({ children, className, asChild }: SelectTriggerProps) {
	const { value, open, setOpen, triggerRef } = useSelectContext();
	const { t } = useI18n();

	const handleClick = () => {
		setOpen(!open);
	};

	// If no children, render a default trigger with current value
	if (!children) {
		return (
			<button
				type="button"
				ref={triggerRef}
				onClick={handleClick}
				className={cn(
					"flex items-center justify-between w-full h-8 px-3 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]",
					className
				)}
				data-state={open ? "open" : "closed"}
			>
				<span className={value ? "" : "text-[var(--muted-foreground)]"}>
					{value || t("common.pleaseSelect")}
				</span>
				<ChevronDown className={cn("w-4 h-4 transition-transform", open && "rotate-180")} />
			</button>
		);
	}

	if (asChild && React.Children.count(children) === 1) {
		const child = React.Children.only(children) as React.ReactElement<any>;
		return React.cloneElement(child, {
			onClick: handleClick,
			'data-state': open ? 'open' : 'closed',
		} as Record<string, unknown>);
	}

	return (
		<button
			type="button"
			ref={triggerRef}
			onClick={handleClick}
			className={cn(
				"flex items-center justify-between w-full h-8 px-3 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]",
				className
			)}
			data-state={open ? "open" : "closed"}
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
	align?: "start" | "center" | "end";
}

function SelectContent({ children, className, align = "end" }: SelectContentProps) {
	const { open, setOpen, triggerRef } = useSelectContext();
	const contentRef = React.useRef<HTMLDivElement>(null);
	const [position, setPosition] = React.useState<React.CSSProperties | null>(null);

	React.useLayoutEffect(() => {
		if (!open) return;
		const trigger = triggerRef.current;
		if (!trigger) return;

		const updatePosition = () => {
			const rect = trigger.getBoundingClientRect();
			const nextPosition: React.CSSProperties = {
				position: "fixed",
				top: rect.bottom + 4,
				minWidth: rect.width,
			};

			if (align === "start") {
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
	}, [align, open, triggerRef]);

	// Close on click outside
	React.useEffect(() => {
		if (!open) return;

		const handleClickOutside = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				contentRef.current &&
				!contentRef.current.contains(target) &&
				!triggerRef.current?.contains(target)
			) {
				setOpen(false);
			}
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

	return createPortal(
		<div
			ref={contentRef}
			style={position ?? undefined}
			className={cn(
				"z-[1500] min-w-[180px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg p-1.5 animate-in fade-in-0 zoom-in-95",
				className
			)}
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
	const { value: selectedValue, onValueChange } = useSelectContext();
	const isSelected = selectedValue === value;

	const handleClick = () => {
		onValueChange(value);
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className={cn(
				"flex min-h-8 items-center w-full gap-2 rounded-md px-2.5 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--muted)] cursor-pointer outline-none",
				className
			)}
		>
			<span className="flex-1 text-left">{children}</span>
			{isSelected && <Check className="w-4 h-4 text-[var(--primary)]" />}
		</button>
	);
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
