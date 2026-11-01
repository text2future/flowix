import { useCallback, useMemo } from 'react';
import { files } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const logger = createLogger('collection-identity-repair');
const MESSAGES = {
  table: {
    success: 'multidimensionalTable.identityRegenerated',
    failed: 'multidimensionalTable.identityRegenerateFailed',
  },
  'media-library': {
    success: 'mediaLibrary.identityRegenerated',
    failed: 'mediaLibrary.identityRegenerateFailed',
  },
} as const;

interface CollectionDocument {
  relativePath: string;
  identityConflict?: boolean;
}

/**
 * 复制出来的集合文件带着同一份身份（collection id），同一个集合会在访问空间里
 * 出现两行。视图分组移除后，树行只剩这一个集合专属动作：给副本重新分配身份。
 * 打开 / 改名 / 删除与普通文档一致，都走文件树自己的事务。
 */
export function useCollectionIdentityRepair({ kind, notebookId, itemsByPath, refresh, updateIdentity }: {
  kind: keyof typeof MESSAGES;
  notebookId: string | null;
  itemsByPath: ReadonlyMap<string, CollectionDocument>;
  refresh: () => Promise<void>;
  updateIdentity: (relativePath: string, collectionId: string) => void;
}) {
  const { t } = useI18n();
  const messages = MESSAGES[kind];
  const makeIdentityUnique = useCallback(async (relativePath: string) => {
    if (!notebookId) return;
    try {
      const collectionId = await files.makeViewDocumentIdentityUnique(notebookId, relativePath);
      updateIdentity(relativePath, collectionId);
      try {
        await refresh();
      } catch (error) {
        // 身份已经落盘，随后的目录刷新失败不能报成修复失败。
        logger.warn('failed to reload catalog after assigning identity', { error, notebookId, relativePath, kind });
      }
      toast.success(t(messages.success));
    } catch (error) {
      logger.warn('failed to regenerate copied collection identity', { error, notebookId, relativePath, kind });
      toast.error(t(messages.failed));
    }
  }, [kind, notebookId, refresh, updateIdentity, messages, t]);

  return useMemo(() => new Map([...itemsByPath].map(([path, item]) => [path, {
    identityConflict: item.identityConflict ?? false,
    onMakeIdentityUnique: () => { void makeIdentityUnique(item.relativePath); },
  }] as const)), [itemsByPath, makeIdentityUnique]);
}
