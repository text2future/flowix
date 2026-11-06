'use client';

import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type HTMLAttributes,
	type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { DIALOG_HEADING_CLASS, DIALOG_OVERLAY_CLASS, DIALOG_SURFACE_CLASS } from './dialog-styles';
import { DialogCloseButton } from './dialog-close-button';
import { DialogAppearanceContext } from './dialog-appearance-context';

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

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
	overlayClassName?: string;
	showOverlay?: boolean;
	showCloseButton?: boolean;
	closeDisabled?: boolean;
	trapFocus?: boolean;
}

const EXIT_ANIMATION_MS = 300;

export function DialogContent({
	children,
	className,
	overlayClassName,
	role,
	'aria-modal': ariaModal,
	showOverlay = true,
	showCloseButton = true,
	closeDisabled = false,
	trapFocus = false,
	tabIndex,
	...contentProps
}: DialogContentProps) {
	const context = useDialogContext();
	const open = context?.open ?? false;
	const onOpenChange = context?.onOpenChange ?? (() => {});
	const contentRef = useRef<HTMLDivElement>(null);
	const previouslyFocusedRef = useRef<HTMLElement | null>(
		typeof document === 'undefined' || !(document.activeElement instanceof HTMLElement)
			? null
			: document.activeElement,
	);

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

	useEffect(() => {
		if (!mounted || !trapFocus) return;

		const content = contentRef.current;
		if (!content) return;

		const appRoot = document.getElementById('root');
		const wasInert = appRoot?.inert ?? false;
		const previouslyFocused = previouslyFocusedRef.current;
		if (appRoot) appRoot.inert = true;

		const focusableSelector = [
			'a[href]',
			'button:not([disabled])',
			'input:not([disabled])',
			'select:not([disabled])',
			'textarea:not([disabled])',
			'[tabindex]:not([tabindex="-1"])',
		].join(',');
		const getFocusableElements = () => {
			const dialogElements = Array.from(content.querySelectorAll<HTMLElement>(focusableSelector));
			// Dropdowns render in a body portal, so include their items while this
			// dialog owns focus.
			const popupElements = Array.from(document.querySelectorAll<HTMLElement>(
				`[data-flowix-surface="popover"] ${focusableSelector}`,
			));
			return [...dialogElements, ...popupElements].filter((element) => (
				!element.hidden && element.getAttribute('aria-hidden') !== 'true'
				&& element.getClientRects().length > 0
			));
		};
		const focusFirst = () => {
			const [first] = getFocusableElements();
			(first ?? content).focus();
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Tab') return;
			const focusable = getFocusableElements();
			if (focusable.length === 0) {
				event.preventDefault();
				content.focus();
				return;
			}

			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			const isOutsideDialog = !content.contains(active)
				&& !(active instanceof Element && active.closest('[data-flowix-surface="popover"]'));

			if (isOutsideDialog || (event.shiftKey && active === first)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		};
		const handleFocusIn = (event: FocusEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (content.contains(target)) return;
			if (target instanceof Element && target.closest('[data-flowix-surface="popover"]')) return;
			focusFirst();
		};

		// autoFocus fields are mounted with the dialog. If focus remained on the
		// page behind it, move focus into the modal immediately.
		if (!content.contains(document.activeElement)) focusFirst();
		document.addEventListener('keydown', handleKeyDown, true);
		document.addEventListener('focusin', handleFocusIn, true);

		return () => {
			document.removeEventListener('keydown', handleKeyDown, true);
			document.removeEventListener('focusin', handleFocusIn, true);
			if (appRoot) appRoot.inert = wasInert;
			if (previouslyFocused?.isConnected) previouslyFocused.focus();
		};
	}, [mounted, trapFocus]);

	const requestClose = () => {
		if (!closeDisabled) onOpenChange(false);
	};

	if (!mounted) return null;

	const overlayAnimationClass = visible
		? 'flowix-fade-enter'
		: open
			? 'flowix-fade-before-enter'
			: 'flowix-fade-leave';
	const contentAnimationClass = visible
		? 'flowix-dialog-enter'
		: open
			? 'flowix-dialog-before-enter'
			: 'flowix-dialog-leave';

	return createPortal(
		<>
			{showOverlay && (
				<div
					data-slot="dialog-overlay"
					className={cn(
						'fixed inset-0 z-[var(--layer-dialog)]',
						DIALOG_OVERLAY_CLASS,
						overlayAnimationClass,
						overlayClassName,
					)}
					onClick={requestClose}
				/>
			)}
			{/* Centering wrapper — keeps the dialog centered without fighting
			    the keyframe's `transform` (which would clobber Tailwind's
			    `-translate-x-1/2 -translate-y-1/2`). `pointer-events-none` lets
			    clicks on the wrapper pass through to the overlay behind. */}
			<div className="fixed inset-0 z-[var(--layer-dialog)] flex items-center justify-center pointer-events-none">
				<div
					ref={contentRef}
					{...contentProps}
					role={role ?? 'dialog'}
					aria-modal={ariaModal ?? true}
					tabIndex={trapFocus ? -1 : tabIndex}
					className={cn(
						'relative w-full max-w-[380px] px-5 py-6 pointer-events-auto',
						showOverlay ? DIALOG_SURFACE_CLASS : 'rounded-2xl bg-[var(--background)] shadow-lg',
						contentAnimationClass,
						className,
					)}
				>
					{showCloseButton && (
						<DialogCloseButton onClick={requestClose} disabled={closeDisabled} />
					)}
					<DialogAppearanceContext.Provider value={showOverlay}>{children}</DialogAppearanceContext.Provider>
				</div>
			</div>
		</>,
		document.body
	);
}

export function DialogHeader({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div className={cn('mb-2 w-full min-w-0', className)}>
			{children}
		</div>
	);
}

export function DialogTitle({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h2 {...props} className={cn(DIALOG_HEADING_CLASS, 'pr-10 text-[var(--foreground)]', className)}>
			{children}
		</h2>
	);
}

export function DialogDescription({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<p className={cn('mt-1 w-full min-w-0 text-sm text-[var(--muted-foreground)]', className)}>
			{children}
		</p>
	);
}
