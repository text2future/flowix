export interface ExternalDocumentOpenRequest {
  filePaths: string[];
  source?: 'open' | 'drop' | 'picker';
  destination?: 0 | 1;
}

export const FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT = 'flowix:external-document-open';

export function requestExternalDocumentOpen(request: ExternalDocumentOpenRequest): void {
  if (!request.filePaths.length) return;
  window.dispatchEvent(new CustomEvent<ExternalDocumentOpenRequest>(FLOWIX_EXTERNAL_DOCUMENT_OPEN_EVENT, {
    detail: request,
  }));
}
