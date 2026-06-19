import * as React from "react";
import { cn } from "../../lib/utils";
import { ChevronDown, Check } from "lucide-react";

// Context for managing select state
interface SelectContextValue {
	value: string;
	onValueChange: (value: string) => void;
	open: boolean;
	setOpen: (open: boolean) => void;
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
}

function Select({ children, value: controlledValue, onValueChange, defaultValue = "" }: SelectProps) {
	const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);

	const value = controlledValue !== undefined ? controlledValue : uncontrolledValue;
	const open = uncontrolledOpen;

	const setOpen = React.useCallback(
		(newOpen: boolean) => {
			setUncontrolledOpen(newOpen);
		},
		[]
	);

	const handleValueChange = React.useCallback(
		(newValue: string) => {
			if (controlledValue === undefined) {
				setUncontrolledValue(newValue);
			}
			onValueChange?.(newValue);
			setOpen(false);
		},
		[controlledValue, onValueChange, setOpen]
	);

	return (
		<SelectContext.Provider value={{ value, onValueChange: handleValueChange, open, setOpen }}>
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
	const { value, open, setOpen } = useSelectContext();

	const handleClick = () => {
		setOpen(!open);
	};

	// If no children, render a default trigger with current value
	if (!children) {
		return (
			<button
				type="button"
				onClick={handleClick}
				className={cn(
					"flex items-center justify-between w-full h-8 px-3 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]",
					className
				)}
				data-state={open ? "open" : "closed"}
			>
				<span className={value ? "" : "text-[var(--muted-foreground)]"}>
					{value || "请选择"}
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
	const { open, setOpen } = useSelectContext();
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

	return (
		<div
			ref={contentRef}
			className={cn(
				"absolute z-50 min-w-[180px] mt-1 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg py-1 animate-in fade-in-0 zoom-in-95",
				alignClass[align],
				className
			)}
		>
			{children}
		</div>
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
				"flex items-center w-full px-3 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--muted)] cursor-pointer outline-none",
				className
			)}
		>
			<span className="flex-1 text-left">{children}</span>
			{isSelected && <Check className="w-4 h-4 text-[var(--primary)]" />}
		</button>
	);
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };