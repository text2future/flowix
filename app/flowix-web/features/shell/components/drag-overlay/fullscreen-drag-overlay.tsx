/**
 * 全屏文件拖拽蒙层：在用户从外部拖入文件到主窗口时（drop 之前）显示高斯模糊 + 提示。
 *
 * 设计要点：
 * - `pointer-events-none`：蒙层仅作视觉指示，不拦截鼠标事件（避免遮蔽命中测试、
 *   不挡 MemoList / DocumentContainer / AgentChat 的 hover/click 行为）。
 * - `z-index` 取 40：高于 LoadingOverlay 的 z-30、低于 bubble menu（如 link-edit-popup
 *   z-9999、drag-context-menu 的 z-999999）—— 蒙层不应挡交互弹层。
 * - 主题色走 `var(--card)` / `var(--foreground)` / `var(--muted-foreground)`，
 *   light / dark / rock 三套主题自动适配。
 */
import { useI18n } from '@features/i18n';

interface FullscreenDragOverlayProps {
  visible: boolean;
  title?: string;
  subtitle?: string;
}

export function FullscreenDragOverlay({
  visible,
  title,
  subtitle,
}: FullscreenDragOverlayProps) {
  const { t } = useI18n();
  const resolvedTitle = title ?? t("shell.dropOverlay.title");
  const resolvedSubtitle = subtitle ?? t("shell.dropOverlay.subtitle");
  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_70%,transparent)] backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-base font-medium text-[var(--foreground)] drop-shadow-sm">
          {resolvedTitle}
        </span>
        {resolvedSubtitle && (
          <span className="text-xs text-[var(--muted-foreground)] drop-shadow-sm">
            {resolvedSubtitle}
          </span>
        )}
      </div>
    </div>
  );
}
