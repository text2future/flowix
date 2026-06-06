'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

interface DialogContextType {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const DialogContext = createContext<DialogContextType | null>(null);

function useDialogContext() {
	const context = useContext(DialogContext);
	if (!context) {
		throw new Error('Dialog components must be used within a Dialog');
	}
	return context;
}

interface DialogProps {
	children: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export function Dialog({ children, open, onOpenChange }: DialogProps) {
	return (
		<DialogContext.Provider value={open !== undefined && onOpenChange ? { open, onOpenChange } : null}>
			{children}
		</DialogContext.Provider>
	);
}

interface DialogTriggerProps {
	children: ReactNode;
	asChild?: boolean;
}

export function DialogTrigger({ children }: DialogTriggerProps) {
	return <>{children}</>;
}

interface DialogContentProps {
	children: ReactNode;
	className?: string;
	fullScreen?: boolean;
	showOverlay?: boolean;
}

const EXIT_ANIMATION_MS = 300;

export function DialogContent({ children, className, showOverlay = true }: DialogContentProps) {
	const context = useDialogContext();
	const open = context?.open ?? false;
	const onOpenChange = context?.onOpenChange ?? (() => {});

	// Drive mount/visibility separately from `open` so the exit animation
	// has time to play before the dialog is removed from the DOM.
	const [mounted, setMounted] = useState(open);
	const [visible, setVisible] = useState(open);

	useEffect(() => {
		if (open) {
			setMounted(true);
			// Defer to the next frame so the browser commits the initial
			// render before flipping to `animate-in`, which triggers the
			// enter animation cleanly.
			const id = requestAnimationFrame(() => setVisible(true));
			return () => cancelAnimationFrame(id);
		}
		setVisible(false);
		const timer = setTimeout(() => setMounted(false), EXIT_ANIMATION_MS);
		return () => clearTimeout(timer);
	}, [open]);

	if (!mounted) return null;

	return createPortal(
		<>
			{showOverlay && (
				<div
					className={cn(
						'fixed inset-0 bg-black/50 z-50',
						visible ? 'woop-fade-enter' : 'woop-fade-leave'
					)}
					onClick={() => onOpenChange(false)}
				/>
			)}
			{/* Centering wrapper — keeps the dialog centered without fighting
			    the keyframe's `transform` (which would clobber Tailwind's
			    `-translate-x-1/2 -translate-y-1/2`). `pointer-events-none` lets
			    clicks on the wrapper pass through to the overlay behind. */}
			<div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
				<div
					className={cn(
						'relative w-full max-w-[380px] rounded-2xl bg-[var(--background)] px-5 py-4 shadow-lg pointer-events-auto',
						visible ? 'woop-dialog-enter' : 'woop-dialog-leave',
						className
					)}
				>
					<button
						onClick={() => onOpenChange(false)}
						className="absolute top-4 right-4 p-1 rounded-md hover:bg-[var(--muted)]"
					>
						<X className="w-4 h-4" />
					</button>
					{children}
				</div>
			</div>
		</>,
		document.body
	);
}

interface DialogCloseProps {
	children?: ReactNode;
}

export function DialogClose({ children }: DialogCloseProps) {
	const context = useDialogContext();
	return (
		<button
			onClick={() => context?.onOpenChange(false)}
			className="absolute top-4 right-4 p-1 rounded-md hover:bg-[var(--muted)]"
		>
			{children || <X className="w-4 h-4" />}
		</button>
	);
}

export function DialogHeader({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div className={cn('mb-3', className)}>
			{children}
		</div>
	);
}

export function DialogTitle({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<h2 className={cn('text-base font-semibold text-[var(--foreground)]', className)}>
			{children}
		</h2>
	);
}

export function DialogDescription({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<p className={cn('text-sm text-[var(--muted-foreground)] mt-1', className)}>
			{children}
		</p>
	);
}