import { marketUiEntryUrl, type MarketUiView } from '@shared/lib/market-ui-url';
import { toast } from '@/lib/toast';
import { openSurfaceAtPosition, type WorkspaceNavigationSource } from '@features/workspace/public/open-surface-api';

export async function openSkillMarketUi(
  view: MarketUiView,
  index: 0 | 1 = 0,
  source?: WorkspaceNavigationSource,
): Promise<boolean> {
  try {
    const result = await openSurfaceAtPosition({ index, source, target: { kind: 'web', url: marketUiEntryUrl(view) } });
    return result.status !== 'cancelled';
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}
