// 桶式导出：仅供外部消费者使用。子目录内部互引请保留单文件路径，避免自循环。
export {
  ACCESS_ACTION,
  createAccessDivider,
  createAccessEntryRow,
  createAccessSectionLabel,
  resolveAccessAction,
  type AccessAction,
  type CreateAccessEntryRowOptions,
  type ResolvedAccessAction,
} from "./access-entries";
export {
  AccessPopoverController,
  type AccessPopoverControllerOptions,
} from "./access-popover-controller";
export { attachAccessPopoverScrollbar } from "./access-popover-scrollbar";