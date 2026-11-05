import { externalDocuments, files } from '@platform/tauri/client';
import { publishCollectionContent } from './content-events';

/**
 * 集合文件网关 ── 集合文件（`.index.yaml` 与独立集合文件）的**默认**写入口。
 *
 * 这一层只干三件事，缺一件就会退回到「同一个文件两个写入口、两份内存副本」的老问题：
 *
 *   1. 写入：带 `expectedContent` 的读改写（CAS），调用方不再各自调 `externalDocuments.write`；
 *   2. 冲突：`mutateCollectionDocument` 在读改写语义下重读重放一次，而不是直接把
 *      「集合文件已变化，请重试」抛给用户（典型场景：表格正在保存单元格时点「新增视图」）；
 *   3. 广播：落盘的最终内容立刻经 `publishCollectionContent` 分发给所有消费者
 *      （集合外壳 summary、表格、图墙、列表），它们不必等刷新或 watcher。
 *
 * 例外：`useCollectionDocumentSession` / `useTableSession` 自带冲突重放与合并语义，
 * 保留自己的 `externalDocuments.write`，但**必须**在写成功后 `publishCollectionContent`
 * —— 广播是义务，网关只是把「CAS + 重试 + 广播」这三件常一起做的事收成一个函数。
 *
 * 边界：网关只保证**本进程内**的一致性与冲突重放；跨进程/外部编辑仍由
 * `expectedContent` 的 CAS 与 watcher 兜底，两者不互相替代。
 */
export type CollectionDocumentWriteStatus = 'conflict' | 'missing' | 'error';

export class CollectionDocumentWriteError extends Error {
  readonly status: CollectionDocumentWriteStatus;

  constructor(status: CollectionDocumentWriteStatus, message: string) {
    super(message);
    this.name = 'CollectionDocumentWriteError';
    this.status = status;
  }
}

export const COLLECTION_WRITE_CONFLICT_MESSAGE = '集合文件已变化，请重试';

function writeError(outcome: { status: 'conflict' | 'missing' | 'error'; message?: string }): CollectionDocumentWriteError {
  if (outcome.status === 'missing') return new CollectionDocumentWriteError('missing', '集合文件已不存在');
  if (outcome.status === 'error') return new CollectionDocumentWriteError('error', outcome.message ?? '集合文件保存失败');
  return new CollectionDocumentWriteError('conflict', COLLECTION_WRITE_CONFLICT_MESSAGE);
}

/** 新建集合文件（尚无 `.index.yaml` 的文件夹入口）。 */
export async function createCollectionDocument(params: {
  indexPath: string;
  notebookPath: string | null;
  content: string;
}): Promise<string> {
  await files.create(params.indexPath, params.content, params.notebookPath ?? undefined);
  publishCollectionContent({ indexPath: params.indexPath, notebookPath: params.notebookPath, content: params.content });
  return params.content;
}

export interface CollectionDocumentMutation<T> {
  /** 新的文件内容；与入参相同表示「无需写盘」。 */
  content: string;
  /** 这次变更的结果，交给调用方（例如新建视图的 id）。 */
  result: T;
}

/**
 * 读改写：读盘 → `mutate(source)` → 写盘。冲突时重读磁盘内容并重放一次
 * （`mutate` 必须是纯函数：只依赖传入的 source，不能闭包住旧的解析结果）。
 *
 * `mutate` 返回与 source 相同的内容时视为无变更：不写盘、不广播，只把结果交回。
 */
export async function mutateCollectionDocument<T>(params: {
  indexPath: string;
  notebookPath: string | null;
  mutate: (source: string) => CollectionDocumentMutation<T>;
  /** 冲突重试次数，默认 1（总写入次数 2）。 */
  retries?: number;
}): Promise<{ content: string; result: T }> {
  const retries = params.retries ?? 1;
  let source = await files.read(params.indexPath, params.notebookPath ?? undefined);
  if (source === null) throw new CollectionDocumentWriteError('missing', '集合文件不存在');
  for (let attempt = 0; ; attempt += 1) {
    const next = params.mutate(source);
    if (next.content === source) return { content: source, result: next.result };
    const outcome = await externalDocuments.write({
      filePath: params.indexPath, scopePath: params.notebookPath,
      expectedContent: source, content: next.content,
    });
    if (outcome.status === 'saved') {
      publishCollectionContent({ indexPath: params.indexPath, notebookPath: params.notebookPath, content: outcome.content });
      return { content: outcome.content, result: next.result };
    }
    if (outcome.status === 'conflict' && attempt < retries) {
      // 拿不到磁盘内容就没法重放（真实后端总会给），按冲突上抛而不是空转。
      if (typeof outcome.diskContent !== 'string') throw writeError(outcome);
      source = outcome.diskContent;
      continue;
    }
    throw writeError(outcome);
  }
}
