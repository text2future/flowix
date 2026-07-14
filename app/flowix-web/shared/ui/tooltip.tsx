import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"
import { ShortcutKbd } from "@shared/ui/shortcut-kbd"

type TooltipSide = "top" | "right" | "bottom" | "left"
type TooltipAlign = "start" | "center" | "end"

interface TooltipProviderProps {
  children: React.ReactNode
  delay?: number
  closeDelay?: number
}

function TooltipProvider({
  children,
  delay = 500,
  closeDelay = 80,
}: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

interface TooltipProps extends Omit<React.HTMLAttributes<HTMLElement>, "content"> {
  children: React.ReactElement
  content?: React.ReactNode
  /**
   * `actions.ts` 里注册的 actionId。给出后会自动:
   *   1. 读取用户当前的 override (`useUserSettings`)
   *   2. 用 `resolveBinding` 算出当前平台实际生效的 chord 字符串
   *   3. 在 content 右侧渲染一个 kbd (用 `formatChord` 平台格式化)
   *
   * 用户在偏好设置里改键后, tooltip 自动跟随更新。
   * actionId 不存在 / 当前平台无 binding → 不渲染 kbd, 只显示 content。
   */
  shortcut?: string
  side?: TooltipSide
  align?: TooltipAlign
  sideOffset?: number
  disabled?: boolean
  className?: string
}

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === "function") {
        ref(node)
      } else {
        ref.current = node
      }
    }
  }
}

function composeHandlers<E extends React.SyntheticEvent>(
  childHandler: ((event: E) => void) | undefined,
  injectedHandler: ((event: E) => void) | undefined,
) {
  return (event: E) => {
    childHandler?.(event)
    if (!event.defaultPrevented) {
      injectedHandler?.(event)
    }
  }
}

const Tooltip = React.forwardRef<HTMLElement, TooltipProps>(function Tooltip({
  children,
  content,
  shortcut,
  side = "top",
  align = "center",
  sideOffset = 6,
  disabled,
  className,
  onClick,
  onMouseDown,
  onPointerDown,
  onKeyDown,
  ...triggerProps
}, forwardedRef) {
  const child = children as React.ReactElement<any>
  const trigger = React.cloneElement(child, {
    ...triggerProps,
    ref: composeRefs((child as any).ref, forwardedRef),
    onClick: composeHandlers(child.props.onClick, onClick),
    onMouseDown: composeHandlers(child.props.onMouseDown, onMouseDown),
    onPointerDown: composeHandlers(child.props.onPointerDown, onPointerDown),
    onKeyDown: composeHandlers(child.props.onKeyDown, onKeyDown),
  })

  // 无 content 也无 shortcut 时, 直接返回 children, 不挂 Tooltip 包裹层
  // (避免给无 hover 信息的按钮增加空 Provider 开销)。
  // shortcut 段: 委托给 ShortcutKbd — 内部读 useUserSettings + resolveBinding,
  // 没 binding 时 ShortcutKbd 自己返回 null, 此处只决定要不要把 Popup 挂上。
  // 因为 ShortcutKbd 是渲染时才解析 chord, 这里没法提前判断"有/无 binding",
  // 所以统一只要 `shortcut` 给了就挂 Popup, ShortcutKbd 渲染期再决定。
  if ((!content && !shortcut) || disabled) {
    return trigger
  }

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={trigger} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          className="z-[1600]"
        >
          <TooltipPrimitive.Popup
            className={cn(
              "relative z-[1600] rounded-md bg-[var(--inverse-background)] px-2 py-1 text-xs text-[var(--inverse-foreground)] shadow-md",
              "transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
              "flex items-center gap-0.5",
              className
            )}
          >
            {content !== undefined && <span>{content}</span>}
            {shortcut && (
              <ShortcutKbd
                actionId={shortcut}
                className="text-[var(--inverse-foreground)] opacity-80"
              />
            )}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
})

export { Tooltip, TooltipProvider }
export type { TooltipAlign, TooltipSide }
