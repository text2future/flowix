export {
  emptyProjection,
  EMPTY_PENDING,
  isProjectionRunActive,
  isProjectionRunEnded,
  type DshCommandRuntimeState,
  type CodexCommandRuntimeState,
  type ThreadProjection,
} from "@features/agent/store/session-reducer/types";
export { reduceProjection } from "@features/agent/store/session-reducer/reduce-projection";
