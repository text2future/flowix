const handledPointerDownEvents = new WeakSet<PointerEvent>();

/**
 * Consume the click that follows an outside pointerdown when it lands on
 * another table-cell popup trigger. This lets the current popup dismiss
 * without opening the next one from the same pointer gesture.
 */
export function consumeCellPopupTriggerClick(event: PointerEvent) {
	if (handledPointerDownEvents.has(event)) return;
	const target = event.target;
	if (!(target instanceof Element)) return;
	const popupTrigger = target.closest('[data-flowix-cell-popup-trigger]');
	if (!popupTrigger) return;

	handledPointerDownEvents.add(event);
	let cleanupTimer = 0;
	const cleanup = () => {
		if (cleanupTimer) window.clearTimeout(cleanupTimer);
		document.removeEventListener('click', handleClick, true);
		document.removeEventListener('pointerup', handlePointerUp, true);
		document.removeEventListener('pointercancel', cleanup, true);
		window.removeEventListener('blur', cleanup);
	};
	const handleClick = (clickEvent: MouseEvent) => {
		// Preserve keyboard-generated clicks, which do not belong to this pointer sequence.
		if (clickEvent.detail === 0) return;
		const clickTarget = clickEvent.target;
		if (!(clickTarget instanceof Element) || clickTarget.closest('[data-flowix-cell-popup-trigger]') !== popupTrigger) return;
		const clickPointerId = (clickEvent as PointerEvent).pointerId;
		if (typeof clickPointerId === 'number' && clickPointerId >= 0 && clickPointerId !== event.pointerId) return;

		clickEvent.preventDefault();
		clickEvent.stopImmediatePropagation();
		cleanup();
	};
	const handlePointerUp = (upEvent: PointerEvent) => {
		if (upEvent.pointerId !== event.pointerId) return;
		// The browser dispatches click after pointerup's default action in the same task.
		cleanupTimer = window.setTimeout(cleanup, 0);
	};

	document.addEventListener('click', handleClick, true);
	document.addEventListener('pointerup', handlePointerUp, true);
	document.addEventListener('pointercancel', cleanup, true);
	window.addEventListener('blur', cleanup, { once: true });
}
