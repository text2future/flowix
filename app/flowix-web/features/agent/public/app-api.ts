import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
export { invalidateDshModelConfigs } from '@features/agent/store/dsh-model-config-store';

export function useAppAgentRuntimeViewModel() {
  // Select the action directly. Returning a fresh object from the Zustand
  // selector makes `getSnapshot()` change on every read, which React treats
  // as an external-store update loop during the initial render.
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  return { refreshAgentRuntime };
}
