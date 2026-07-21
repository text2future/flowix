'use client';

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "@features/i18n";
import { windows } from "@platform/tauri/client";
import { useDocumentStore } from "@features/document/store/document-store";
import { useMemoStore } from "@features/memo/store/memo-store";
import { useTagStore } from "@features/memo/store/tag-store";
import { useTodoCountStore } from "@features/memo/store/todo-count-store";
import { invalidateMentionNotes } from "@features/editor/extensions/note-mention";
import { invalidateMentionTags, setNotebookIdProvider } from "@features/editor/extensions/tag-mention";
import { rebaseSelectedTagId } from "@features/memo/services/memo-list-metadata-service";
import { toast } from "@/lib/toast";
import { handleMainWindowMemoEvent } from "./main-window-memo-event-handler";
import type { MemoEvent } from "@/types/memo";
import {
  mountOpenTargetListener,
  unmountOpenTargetListener,
} from "@platform/open-target";

export function MainWindowEffects() {
  const { t } = useI18n();
  const mainWindowTitle = t("window.main.title");

  useEffect(() => {
    document.title = mainWindowTitle;
    void getCurrentWindow().setTitle(mainWindowTitle).catch(() => {
      // Browser preview or unavailable Tauri window API.
    });
  }, [mainWindowTitle]);

  // 注入 notebookId 读取函数: tag-mention 的 `#` 补全按当前 notebook 过滤。
  // 用 provider 解耦, 避免 editor 模块直接 import memo-store (会改变加载链
  // 顺序, 破坏 composer 等的 mock 时序)。provider 是 live 函数, 每次 `#`
  // 触发时读最新 selectedNotebook。
  useEffect(() => {
    setNotebookIdProvider(() => useMemoStore.getState().selectedNotebook?.id ?? null);
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let disposed = false;

    void import("@/lib/memo-dispatcher").then(({ registerMemoEventHandler }) => {
      if (disposed) return;
      unsubscribe = registerMemoEventHandler((event) => {
        handleMainWindowMemoEvent(event, {
          getSelectedNotebookId: () => useMemoStore.getState().selectedNotebook?.id ?? null,
          invalidateMentionCaches: () => {
            invalidateMentionNotes();
            invalidateMentionTags();
          },
          openNoteTab: windows.openNoteTab,
          reportOpenFailure: (error) => {
            console.warn("[MainWindowEffects] open created note window failed", error);
            toast.error(error instanceof Error ? error.message : String(error));
          },
          handleMemoCreated: (memo) => useMemoStore.getState().handleMemoCreated(memo),
          handleMemoUpdated: (memo) => useMemoStore.getState().handleMemoUpdated(memo),
          handleMemoDeleted: (memoId) => useMemoStore.getState().handleMemoDeleted(memoId),
          handleTagsRenamed,
          replaceActiveMemoPath: (memoId, path) => {
            useDocumentStore.getState().replaceActiveMemoPath(memoId, path);
          },
          refreshSelectedNotebookMetadata,
          refreshBackgroundTodoCount: (notebookId) => {
            void useTodoCountStore.getState().loadTodoCount(notebookId);
          },
        });
      });
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    void mountOpenTargetListener();
    return () => {
      unmountOpenTargetListener();
    };
  }, []);

  return null;
}

function refreshSelectedNotebookMetadata(event: MemoEvent): void {
  // tags_renamed 不走这条路径 (handler 早返回了), 但函数类型是 MemoEvent
  // 联合, 需要在这里收窄 ── 'tags_renamed' 没有 derivedChanged 字段。
  if (event.kind === 'tags_renamed') return;
  const { notebookId, derivedChanged } = event;
  if (derivedChanged.tags || derivedChanged.agents || derivedChanged.todos) {
    void useTagStore.getState().loadTags(notebookId);
    useTagStore.getState().triggerMetadataRefresh();
  }
  if (derivedChanged.todos) {
    void useTodoCountStore.getState().loadTodoCount(notebookId);
  }
}

/**
 * 处理 move_memo_tag IPC 的一次性 TagsRenamed 事件。
 *
 * 旧实现: 每个 affected memo 各发一次 MemoEvent::Updated, 触发 N 次
 *   handleMemoUpdated (整个 memo 对象被替换) + refreshSelectedNotebookMetadata
 *   (loadTags + triggerMetadataRefresh) + bump refreshTrigger
 *   (loadData + loadMemos 全量重拉)。 即使用户选中的是与重命名无关的
 *   标签 A, 列表也会闪烁一次, 卡片 tag token 全部更新 ── "列表内容
 *   变化"的根因。
 *
 * 新实现: 后端只发一次 TagsRenamed, 这里只做必要工作:
 *   1) loadTags + triggerMetadataRefresh ── 重载标签树 (后端 derived
 *      tagOptions 已不含旧路径, 不能缺)
 *   2) 局部 patch memos 数组里命中 affectedMemoIds 的行, 把 .tags
 *      数组按 renamedTags 做前缀替换 (复用 rebaseSelectedTagId 的核心
 *      逻辑)。 body / preview / todos / updatedAt 都没动, 不替换整个
 *      memo 对象 (除非 tags 真变了)。
 *   3) **不 bump refreshTrigger** ── selectedTagId 是否变由
 *      note-navigation-panel 的 commitRename / applyTagMove 自己 rebase,
 *      useEffect [activeTagId] 自动触发 loadMemos 走新 tagId 重拉。
 *      所以这里不需要 triggerRefresh。
 *
 * 注意: notebookId 失配也照样 patch memos 数组。 失配场景是"用户选中了
 * 其他 notebook, 后端仍会把 background notebook 的 memos 改写", 切回
 * 时看到的就是新 tag, 不会 stale。
 */
function handleTagsRenamed(
  event: Extract<MemoEvent, { kind: 'tags_renamed' }>,
): void {
  const { notebookId, renamedTags, affectedMemoIds } = event;

  // 1) 重载标签树 metadata ── tagOptions 必须反映新路径 (旧路径被
  //    renameSelectedTagId 校验会判 null, 触发"重命名后选中态丢失")。
  void useTagStore.getState().loadTags(notebookId);
  useTagStore.getState().triggerMetadataRefresh();

  // 2) 局部 patch memos 数组: 只动命中 affectedMemoIds 的行, 每个
  //    memo 只重写 .tags 字段, 其他字段引用保持不变。
  //
  //    复用 `rebaseSelectedTagId`: 对每个 tag token 依次跑一遍
  //    renamedTags ── 不匹配时该函数原样返回 (但类型是 `string | null`),
  //    所以链式累加用 `?? current` 兜底, 保证 TS 不会把 accumulator 推到
  //    `string | null`。 这也意味着 renamedTags 即使有前缀嵌套 / 互不
  //    重叠, 都能顺序尝试。
  if (affectedMemoIds.length === 0 || renamedTags.length === 0) return;
  const idSet = new Set(affectedMemoIds);
  const memos = useMemoStore.getState().memos;
  let dirty = false;
  const nextMemos = memos.map((memo) => {
    if (!idSet.has(memo.id)) return memo;
    const newTags = memo.tags.map((tag) => {
      let current = tag;
      for (const [oldPrefix, newPrefix] of renamedTags) {
        current = rebaseSelectedTagId(current, oldPrefix, newPrefix) ?? current;
      }
      return current;
    });
    if (
      newTags.length === memo.tags.length &&
      newTags.every((t, i) => t === memo.tags[i])
    ) {
      return memo;
    }
    dirty = true;
    return { ...memo, tags: newTags };
  });
  if (dirty) {
    useMemoStore.setState({ memos: nextMemos });
  }
}
