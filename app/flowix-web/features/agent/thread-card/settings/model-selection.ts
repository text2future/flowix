import type { AgentTypeKey } from '@/types/agent';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import {
  FLOWIX_CLOUD_PREVIEW_PROVIDER_ID,
  type CloudAccessKind,
} from '@features/agent/config/cloud-access';
import { isFlowixCloudModelOption } from './model-picker/pi-model-picker';
import type { AgentModelOption } from './model-picker/model-picker-types';

export interface ModelSelectionHooks {
  typeKey: AgentTypeKey;
  apply: (option: AgentModelOption) => void;
  closePopover: () => void;
  onCloudAccessBlocked?: (kind: CloudAccessKind) => void;
}

/**
 * Apply a model picked from the settings list.
 *
 * Two Cloud rules live here rather than in the frozen controller: a signed-out
 * catalog entry is a preview with no local provider (selecting it would bind a
 * model the next run cannot resolve), and a stale member item from a previous
 * session must not be written. Credit access is checked atomically by Cloud
 * when a request starts.
 */
export function selectAgentModel(
  hooks: ModelSelectionHooks,
  option: AgentModelOption,
): void {
  if (hooks.typeKey === 'pi' && isFlowixCloudModelOption(option)) {
    if ((option.providerId ?? '') === FLOWIX_CLOUD_PREVIEW_PROVIDER_ID) {
      hooks.onCloudAccessBlocked?.('signed_out');
      hooks.closePopover();
      return;
    }
    const available = useAgentDataStore.getState().agents.pi.catalog.models.items.some(
      (model) => isFlowixCloudModelOption(model)
        && model.id === option.id
        && (model.providerId ?? '') === (option.providerId ?? ''),
    );
    // A missing entry means the next run cannot resolve it either: a signed-out
    // account has no Cloud provider installed. Returning silently here made the
    // click look applied while the send quietly fell back to the local model, so
    // ask for a sign-in instead.
    if (!available) {
      if (!useAgentDataStore.getState().piCloudAccountId) {
        hooks.onCloudAccessBlocked?.('signed_out');
      }
      hooks.closePopover();
      return;
    }
  }
  hooks.apply(option);
  hooks.closePopover();
}
