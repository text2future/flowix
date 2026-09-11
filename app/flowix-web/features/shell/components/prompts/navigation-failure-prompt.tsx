import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@shared/ui/button';
import { FloatingPrompt } from '@features/shell/components/floating-prompt';
import {
  dismissNavigationFailure,
  retryLastNavigation,
  useWorkspaceNavigationFailure,
} from '@features/workspace/public/main-window-api';

export function NavigationFailurePrompt() {
  const { t } = useI18n();
  const failure = useWorkspaceNavigationFailure();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setRetrying(false);
  }, [failure?.requestId]);

  const handleRetry = async () => {
    if (!failure || retrying) return;
    setRetrying(true);
    try {
      await retryLastNavigation();
    } catch {
      // The coordinator publishes the new failure; keep this prompt open.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <FloatingPrompt
      open={failure !== null}
      onClose={dismissNavigationFailure}
      className="p-4 pr-12"
    >
      <div className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-[var(--foreground)]">
            {t('shell.navigation.failed')}
          </div>
          <div className="mt-1 break-words text-xs text-[var(--muted-foreground)]">
            {failure?.message}
          </div>
        </div>
        <Button type="button" size="sm" disabled={retrying} onClick={() => void handleRetry()}>
          {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('error.retry')}
        </Button>
      </div>
    </FloatingPrompt>
  );
}
