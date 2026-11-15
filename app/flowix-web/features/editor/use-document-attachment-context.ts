import { useCallback, useRef } from 'react';
import { getDocumentResourceContext } from '@features/document/public/resource-context';
import type { DocumentResourceContext } from '@/lib/document-resource-context';

/**
 * 编辑器挂载时读到的「当前文档资源上下文」。
 *
 * 挂载 effect 不能因为路径变化重建编辑器，所以调用方给的是 getter，值放在 ref 里
 * 每次渲染刷新；没有 getter 时退回按 `ownerPath` 现算。三条派生 getter 都走同一次
 * 解析，编辑器里调用点很多，别让它各算一遍。
 */
export function useDocumentAttachmentContext(
  ownerPath: string | undefined,
  getAttachmentContext?: () => DocumentResourceContext,
) {
  const currentRef = useRef({ ownerPath, getAttachmentContext });
  currentRef.current = { ownerPath, getAttachmentContext };

  const getContext = useCallback(() => {
    const current = currentRef.current;
    return current.getAttachmentContext?.() ?? getDocumentResourceContext(current.ownerPath);
  }, []);
  const getOwnerPath = useCallback(() => getContext().ownerPath, [getContext]);
  const getDocumentPath = useCallback(() => getContext().documentPath, [getContext]);
  return { getContext, getOwnerPath, getDocumentPath };
}
