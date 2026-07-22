// 后端 MemoEvent 的 TypeScript 镜像 — 硬契约, 跟 app/flowix-desktop/src/memo_events.rs
// 保持一致。`kind` 必须是 snake_case, 字段命名 (id/path/source/memo) 是跨
// IPC 边界的约定, 不要随便改。
//
// 注意: 之前 v4 注释声称新增 `Batch` 变体 + 200ms 桶 flush 收口, 后端
// (`app/flowix-desktop/src/memo_events.rs::MemoEvent`) 实际只有
// Created/Updated/Deleted 三个变体, 不发 Batch。前端 dedup/合并由
// `lib/event-dispatcher.ts` 的 middleware 提供 (last-write-wins 同 id 合并),
// 不依赖后端发批量事件。

import type { MemoItem } from '@/types/memo-item';

export type MemoChangeSource =
  | 'user_new'
  | 'user_import'
  | 'user_edit'
  | 'external_tool';

export type MemoDerivedChanged = {
  tags: boolean;
  todos: boolean;
  agents: boolean;
};

export type MemoEvent =
  | {
      kind: 'created';
      memo: MemoItem;
      notebookId: string;
      derivedChanged: MemoDerivedChanged;
      source: MemoChangeSource;
    }
  | {
      kind: 'updated';
      id: string;
      path: string;
      memo: MemoItem;
      notebookId: string;
      derivedChanged: MemoDerivedChanged;
      source: MemoChangeSource;
    }
  | {
      kind: 'deleted';
      id: string;
      path: string;
      notebookId: string;
      derivedChanged: MemoDerivedChanged;
    }
  | {
      kind: 'tags_renamed';
      notebookId: string;
      renamedTags: Array<[string, string]>;
      affectedMemoIds: string[];
    }
  | {
      kind: 'tags_deleted';
      notebookId: string;
      deletedTags: string[];
      affectedMemoIds: string[];
    };
