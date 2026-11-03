/**
 * Dev mock for the top floating "actionable notice" (顶部悬浮提示条).
 *
 * Run:  npm run dev  然后打开  http://localhost:1420/mock/actionable-notice.html
 *
 * 它直接渲染产品里的真实组件 `ActionableNoticeHost`, 并用真实的 notice store
 * 灌数据, 所以 DOM / 样式 / 交互都与线上一致。
 *
 * 覆盖的 notice 类型 (与真实业务调用对齐):
 *   - error   + 可关闭 + 重试         → 笔记本导入失败
 *   - warning + 双动作 + 不可关闭      → 文档保存版本冲突 (document-save-status)
 *   - error   + 不可关闭 + 重试        → csv / 文档保存失败
 *   - neutral + outline 动作          → 一般信息提示
 *   - destructive 动作变体            → 危险操作确认
 *   - 动作抛错 → actionError 红字行   → 动作执行失败
 *   - 长任务   → spinner + 处理中…    → 观察 busy 态
 *   - 无动作 / 超长副文案 / 堆叠多条
 */
import { createRoot } from "react-dom/client";
import { StrictMode, useEffect, useState, type ReactNode } from "react";

import "@/styles/index.css";

import { ActionableNoticeHost } from "@/features/notifications/actionable-notice-host";
import {
  clearActionableNotice,
  getActionableNotices,
  subscribeActionableNotices,
  upsertActionableNotice,
  type ActionableNotice,
} from "@/features/notifications/actionable-notice-store";
import { I18nProvider } from "@/lib/i18n";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const IMPORT_FAILURE_ID = "mock-import-failure";

/** error + 可关闭 + 单个 default 重试。 */
function seedImportFailure() {
  upsertActionableNotice({
    id: IMPORT_FAILURE_ID,
    priority: 50,
    tone: "error",
    title: "笔记本导入失败",
    message: "导入索引时发生错误，可以重试。",
    revision: "rev-1",
    dismissible: true,
    actions: [{ id: "retry", label: "重试", variant: "default", run: () => sleep(1500) }],
  });
}

/** warning + 双动作 (outline + default) + 不可关闭。对齐 document-save-status 的冲突分支。 */
function seedConflict() {
  upsertActionableNotice({
    id: "mock-conflict",
    priority: 70,
    tone: "warning",
    title: "设计稿.flowix · 保存版本和磁盘内容冲突",
    message: "文件已被外部修改，你的编辑已保留。\n磁盘版本写于 2 分钟前。",
    revision: "rev-1",
    actions: [
      { id: "disk", label: "使用磁盘版本", variant: "outline", run: () => sleep(800) },
      { id: "local", label: "使用编辑版本", variant: "default", run: () => sleep(800) },
    ],
  });
}

/** neutral + outline 动作 + 可关闭。一般信息提示。 */
function seedNeutral() {
  upsertActionableNotice({
    id: "mock-neutral",
    priority: 30,
    tone: "neutral",
    title: "有新版本可用",
    message: "当前 1.5.6，最新 1.5.7。",
    revision: "rev-1",
    dismissible: true,
    actions: [{ id: "later", label: "稍后", variant: "outline", run: () => {} }],
  });
}

/** error + 不可关闭 (无关闭按钮) + 重试。对齐 csv / 文档保存失败。 */
function seedSaveFailed() {
  upsertActionableNotice({
    id: "mock-save-failed",
    priority: 80,
    tone: "error",
    title: "设计稿.flowix",
    message: "保存失败：磁盘空间不足。",
    revision: "rev-1",
    actions: [{ id: "retry", label: "重试保存", variant: "default", run: () => sleep(1500) }],
  });
}

/** destructive 动作变体 (配一个 outline 取消)。 */
function seedDestructive() {
  upsertActionableNotice({
    id: "mock-destructive",
    priority: 90,
    tone: "error",
    title: "同步仓库凭据已失效",
    message: "需要重新授权，否则无法推送。",
    revision: "rev-1",
    dismissible: true,
    actions: [
      { id: "cancel", label: "取消", variant: "outline", run: () => {} },
      { id: "remove", label: "移除仓库", variant: "destructive", run: () => sleep(800) },
    ],
  });
}

/** 动作抛错 → store 会写入 actionError, 卡片展示红字错误行。 */
function seedActionError() {
  upsertActionableNotice({
    id: "mock-action-error",
    priority: 85,
    tone: "error",
    title: "导出 PDF 失败",
    message: "点击重试以复现动作报错。",
    revision: "rev-1",
    dismissible: true,
    actions: [
      {
        id: "retry",
        label: "重试",
        variant: "default",
        run: async () => {
          await sleep(600);
          throw new Error("EACCES: permission denied, open '/Users/me/Export/report.pdf'");
        },
      },
    ],
  });
}

/** 长任务 → 观察 spinner + “处理中…” 与按钮 / 关闭禁用。 */
function seedWorking() {
  upsertActionableNotice({
    id: "mock-working",
    priority: 88,
    tone: "warning",
    title: "正在重建索引",
    message: "12,480 个笔记，请稍候。",
    revision: "rev-1",
    dismissible: true,
    actions: [{ id: "run", label: "开始重建", variant: "default", run: () => sleep(6000) }],
  });
}

/** 无动作, 仅可关闭。 */
function seedNoActions() {
  upsertActionableNotice({
    id: "mock-no-actions",
    priority: 20,
    tone: "neutral",
    title: "已切换到离线模式",
    message: "网络恢复后会自动同步。",
    revision: "rev-1",
    dismissible: true,
    actions: [],
  });
}

/** 超长副文案 + 右侧重试按钮, 用来验证 1 行省略。 */
function seedLongMessage() {
  upsertActionableNotice({
    id: "mock-long-message",
    priority: 60,
    tone: "error",
    title: "笔记本导入失败 · 索引重建未完成",
    message:
      "尝试读取笔记本中的文件并重建索引时发生错误。这条副文案会故意写得很长很长，用来确认右侧重试按钮与单行省略同时生效，超出一行的部分应当以省略号截断而不是把卡片撑高。",
    revision: "rev-1",
    dismissible: true,
    actions: [{ id: "retry", label: "重试", variant: "default", run: () => sleep(1500) }],
  });
}

/** 堆叠多个不同 tone, 演示 max-height + 滚动。 */
function seedStack() {
  const tones = ["error", "warning", "neutral"] as const;
  for (let i = 0; i < 4; i += 1) {
    upsertActionableNotice({
      id: `mock-stack-${i}`,
      priority: 10 - i,
      tone: tones[i % tones.length],
      title: `堆叠通知 ${i + 1} · 演示 max-height 与滚动`,
      message: "多条通知超过 max-h-[calc(100vh-4rem)] 时, 宿主容器整体出现滚动条。",
      revision: "rev-1",
      dismissible: true,
      actions: [],
    });
  }
}

/** 一次性铺开所有类型, 便于横向对照。 */
function seedAllTypes() {
  seedImportFailure();
  seedConflict();
  seedNeutral();
  seedSaveFailed();
  seedDestructive();
  seedActionError();
  seedWorking();
  seedNoActions();
}

function PanelButton({
  children,
  onClick,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 28,
        padding: "0 10px",
        fontSize: 12,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: active ? "var(--primary)" : "var(--card)",
        color: active ? "var(--primary-foreground)" : "var(--foreground)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
      <span style={{ opacity: 0.7, width: 44, lineHeight: "28px", flexShrink: 0 }}>{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{children}</div>
    </div>
  );
}

function MockPanel() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "rock");
  const [, force] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeActionableNotices(() => force((n) => n + 1));
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const notices = getActionableNotices();

  return (
    <div
      style={{
        position: "fixed",
        left: 16,
        bottom: 16,
        zIndex: 2147483646,
        width: 400,
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--foreground)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ fontSize: 13 }}>Actionable Notice · dev mock</strong>

      <Row label="场景">
        <PanelButton onClick={seedImportFailure}>导入失败</PanelButton>
        <PanelButton onClick={seedLongMessage}>超长副文案</PanelButton>
        <PanelButton onClick={seedStack}>堆叠 4 条</PanelButton>
      </Row>

      <Row label="语气">
        <PanelButton onClick={seedConflict}>冲突 warning</PanelButton>
        <PanelButton onClick={seedNeutral}>提示 neutral</PanelButton>
        <PanelButton onClick={seedSaveFailed}>保存失败（不可关）</PanelButton>
      </Row>

      <Row label="动作">
        <PanelButton onClick={seedDestructive}>destructive</PanelButton>
        <PanelButton onClick={seedActionError}>动作报错</PanelButton>
        <PanelButton onClick={seedWorking}>长任务</PanelButton>
        <PanelButton onClick={seedNoActions}>无动作</PanelButton>
      </Row>

      <Row label="视图">
        <PanelButton onClick={seedAllTypes}>全部类型</PanelButton>
        <PanelButton
          onClick={() => notices.forEach((n: ActionableNotice) => clearActionableNotice(n.id))}
        >
          清空全部
        </PanelButton>
      </Row>

      <Row label="主题">
        {["light", "dark", "rock", "ember"].map((value) => (
          <PanelButton key={value} active={theme === value} onClick={() => setTheme(value)}>
            {value}
          </PanelButton>
        ))}
      </Row>

      <div style={{ opacity: 0.6 }}>
        当前 notice 数: {notices.length} · theme=<code>{theme}</code>
      </div>
    </div>
  );
}

// 页面加载即灌入代表性数据 (三种 tone + 不可关闭), 打开就能看到多条不同类型。
// 必须在 render 之前调用: ActionableNoticeHost 用 useSyncExternalStore
// 读 store 快照, 先 seed 才能保证首帧就渲染出来。
seedImportFailure();
seedConflict();
seedNeutral();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider language="zh-CN">
      <ActionableNoticeHost />
      <MockPanel />
    </I18nProvider>
  </StrictMode>,
);
