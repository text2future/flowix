import { useEffect, useRef } from 'react';
import { registerWindowCloseRegion, subscribeNativeCloseRouting } from '@platform/tauri/window-close-region';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@platform/tauri/window";
import { Tooltip } from "@shared/ui/tooltip";
import { useI18n } from "@/lib/i18n";

let lastAnnouncedRoutingStatus: boolean | undefined;

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function isTauriApp(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

interface WindowsTitlebarControlsProps {
  showBottomBorder?: boolean;
  reserveSpace?: boolean;
}

export function WindowsTitlebarControls({
  showBottomBorder = false,
  reserveSpace = false,
}: WindowsTitlebarControlsProps) {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const translate = useRef(t);
  translate.current = t;
  useEffect(() => {
    if (isWindowsPlatform() && isTauriApp() && closeButton.current) {
      const unregisterRegion = registerWindowCloseRegion(closeButton.current);
      const unsubscribeHealth = subscribeNativeCloseRouting(ready => {
        if (lastAnnouncedRoutingStatus === ready) return;
        const wasKnown = lastAnnouncedRoutingStatus !== undefined;
        lastAnnouncedRoutingStatus = ready;
        if (!ready) {
          toast.warning(translate.current('window.closeNativeUnavailable'));
        } else if (wasKnown) {
          toast.success(translate.current('window.closeNativeRestored'));
        }
      });
      return () => {
        unregisterRegion();
        unsubscribeHealth();
      };
    }
  }, []);
  if (!isWindowsPlatform() || !isTauriApp()) return null;

  return (
    <>
      {reserveSpace && <div aria-hidden="true" className="h-[var(--window-titlebar-height)] w-full flex-none" />}
      <div className="fixed top-0 right-0 z-[100] flex h-[var(--window-titlebar-height)] select-none bg-[color-mix(in_oklch,var(--bg-titlebar)_32%,transparent)] pointer-events-auto [-webkit-app-region:no-drag]">
        <Tooltip content={t('window.minimize')} side="bottom">
          <button
            type="button"
            aria-label={t('window.minimize')}
            onClick={() => getCurrentWindow().minimize()}
            className="flex h-[var(--window-titlebar-height)] w-[var(--window-control-button-width)] items-center justify-center text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] [-webkit-app-region:no-drag]"
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip content={t('window.maximize')} side="bottom">
          <button
            type="button"
            aria-label={t('window.maximize')}
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="flex h-[var(--window-titlebar-height)] w-[var(--window-control-button-width)] items-center justify-center text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] [-webkit-app-region:no-drag]"
          >
            <Square className="h-3 w-3" strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip content={t('window.close')} side="bottom">
          <button
            type="button"
            aria-label={t('window.close')}
            ref={closeButton}
            onClick={() => {
              void getCurrentWindow().close().catch(() => {
                createLogger('window:controls').error('close request failed');
                toast.error(t('window.closeRequestFailed'));
              });
            }}
            className="flex h-[var(--window-titlebar-height)] w-[var(--window-control-button-width)] items-center justify-center text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)] hover:text-[var(--floating-foreground)] [-webkit-app-region:no-drag]"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </Tooltip>
        {showBottomBorder && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-px bg-[var(--divider)]"
          />
        )}
      </div>
    </>
  );
}
