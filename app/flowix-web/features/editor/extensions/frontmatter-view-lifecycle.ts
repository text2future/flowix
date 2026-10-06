import { subscribeAppLanguage, subscribePropertyFieldPreferences } from '@features/preferences/public/runtime-api';
import { useSettingsStore } from '@/lib/store/settings-store';

interface FrontmatterViewHandlers {
  render: () => void;
  pointerDown: (event: Event) => void;
  selectStart: (event: Event) => void;
  addProperty: (event: Event) => void;
  occupiedKeys: (event: Event) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: (event: PointerEvent) => void;
  blur: () => void;
}

/** All external subscriptions of a frontmatter view share one disposal boundary. */
export function observeFrontmatterView(document: Document, handlers: FrontmatterViewHandlers): () => void {
  const view = document.defaultView;
  const controller = new (view?.AbortController ?? AbortController)();
  const signal = controller.signal;
  const unsubscribeLanguage = subscribeAppLanguage(handlers.render);
  const unsubscribeProperties = useSettingsStore.subscribe((state, previous) => {
    if (state.propertiesVisible !== previous.propertiesVisible) handlers.render();
  });
  const unsubscribePresets = subscribePropertyFieldPreferences(handlers.render);
  document.addEventListener('pointerdown', handlers.pointerDown, { capture: true, signal });
  document.addEventListener('selectstart', handlers.selectStart, { capture: true, signal });
  view?.addEventListener('flowix:add-property', handlers.addProperty, { signal });
  view?.addEventListener('flowix:query-occupied-property-keys', handlers.occupiedKeys, { signal });
  view?.addEventListener('pointermove', handlers.pointerMove, { signal });
  view?.addEventListener('pointerup', handlers.pointerUp, { signal });
  view?.addEventListener('pointercancel', handlers.pointerCancel, { signal });
  view?.addEventListener('blur', handlers.blur, { signal });
  return () => {
    if (signal.aborted) return;
    controller.abort();
    unsubscribeLanguage();
    unsubscribeProperties();
    unsubscribePresets();
  };
}
