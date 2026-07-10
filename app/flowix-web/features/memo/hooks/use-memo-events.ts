// 后端 `memo-event` 事件总线的前端入口 — 触发 `lib/memo-dispatcher.ts`
// 顶层副作用 (单一 Tauri 订阅 + handler 注册), 挂在 App.tsx 顶层让
// 主窗口和偏好设置窗口都同步。
//
// 设计:
// - 副作用模块 (`memo-dispatcher.ts`) 自己挂 1 个 Tauri listener, 把
//   payload 转给 `memoDispatcher.dispatch`。 本 hook 只负责"在 App
//   启动时 import 这个副作用模块", 不再做任何 switch / 业务判断。
// - 各 handler 用 `memoDispatcher.subscribe(handler, filter)` 声明式
//   注册, filter 按 kind / source / path 自定。 当前注册 4 个 handler:
//   3 个 memo-store action + 1 个活动编辑器 reload。
// - 新增 handler (toast / window focus / tagMap 重建) 只调一次
//   `registerMemoEventHandler`, 不用改本文件。

// Side-effect import — 触发 memo-dispatcher 顶层的 installMemoEventBridge()
// 和 handler 注册。 这是模块级副作用, 只在第一次 import 时执行, 后续
// import 走模块缓存不再重复触发。
import '@/lib/memo-dispatcher';

/**
 * 占位 hook: 保留 API 给 App.tsx 调用, 副作用在 import 时已发生。
 * 函数本身不做任何运行时工作 ── 注册路径全在 memo-dispatcher.ts 模块顶层。
 */
export function useMemoEvents(): void {
  /* no-op */
}