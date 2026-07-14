import { MoreHorizontal } from 'lucide-react';
import { getAgentType, type AgentTypeKey } from '@/lib/agent-types';
import { cn } from '@/lib/utils';

const STACK_ORDER: AgentTypeKey[] = ['flowix', 'hermes', 'codex', 'claude'];

/** 单个 icon 主体 20px, 图片 14px, 相邻 14px 偏移 (30% 重叠), 总宽 62px。
 *  30% 重叠 = 70% 偏移 (offset = size × 0.7), 即每个 icon 露出的"新"宽度
 *  是 70% (14px), 跟下一个 icon 互相盖 30% (6px)。 */
const ICON_SIZE = 20;
const ICON_IMG_SIZE = 14;
const ICON_OFFSET = ICON_SIZE * 0.7; // = 14
const STACK_WIDTH = ICON_SIZE + 3 * ICON_OFFSET; // = 62

/**
 * 偏好设置侧栏 "AI Agent" tab 的图标 ── 4 个 agent 品牌图标并列堆叠。
 *
 * 视觉: Flowix / Hermes / Codex / Claude Code, 圆形带 1px 描边,
 * 描边色等于所在容器背景 (--card) 用来在重叠处制造"分隔感",
 * 模仿头像堆叠的视觉。每个相邻图标水平方向 50% 偏移 (即 50% 重叠)。
 *
 * 顺序与层叠 (从左到右 / 从底到顶 一一对应):
 *   Flowix (左, 底层) → Hermes → Codex → Claude (右, 顶层)
 *
 * 实现要点: 用 absolute 定位 + 固定宽度的 relative 容器, 不用
 * negative margin。 这样外层 button 的 flex 布局拿到的 icon 尺寸
 * 始终是 STACK_WIDTH (45px), 不会受子元素 margin 影响导致 gap 漂移。
 */
export function AgentIconStack({ className }: { className?: string }) {
  return (
    <span
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: STACK_WIDTH, height: ICON_SIZE }}
    >
      {STACK_ORDER.map((key, index) => {
        const type = getAgentType(key);
        return (
          <span
            key={key}
            className="absolute inline-flex items-center justify-center overflow-hidden rounded-full border bg-[var(--background)]"
            style={{
              left: index * ICON_OFFSET,
              width: ICON_SIZE,
              height: ICON_SIZE,
              zIndex: index + 1,
              // 描边色: 95% --border (浅灰) + 5% --muted-foreground (中灰)
              // 加深幅度再减半 (lightness 约 -1.6%), 主题自适应, 几乎不可见。
              borderColor:
                'color-mix(in oklch, var(--border) 95%, var(--muted-foreground) 5%)',
            }}
          >
            {key === 'flowix' ? (
              // Flowix 占位用 lucide MoreHorizontal (⋯) — 三个横点, 表
              // 示"更多 agent / 切换"; 颜色走 muted-foreground 跟其他
              // 品牌 icon 的彩色形成对比, 不抢戏。
              <MoreHorizontal
                style={{ width: ICON_IMG_SIZE, height: ICON_IMG_SIZE }}
                className="text-[var(--muted-foreground)]"
                strokeWidth={2}
              />
            ) : (
              <img
                src={type.icon}
                alt=""
                style={{ width: ICON_IMG_SIZE, height: ICON_IMG_SIZE }}
                className="object-contain"
                draggable={false}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}
