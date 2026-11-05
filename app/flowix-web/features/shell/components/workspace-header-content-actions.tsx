import type { ComponentProps, ReactNode } from 'react';
import {
  ExternalDocumentActions, ExternalTitlebarBadge, MediaActions,
  type DocumentTitlebarProps,
} from '@features/document/public/header-api';
import { CollectionDisplayMenu } from '@features/collection/public/header-api';

type DocumentActions = Omit<ComponentProps<typeof ExternalDocumentActions>, 'iconButtonClass' | 'visible' | 'collectionDisplay'>;
type MediaActionProps = Omit<ComponentProps<typeof MediaActions>, 'iconButtonClass' | 'collectionDisplay'>;

/** Content menus are shared across sessions and physical hosts. Adapters only bind commands. */
export function WorkspaceHeaderContentActions({ document, media, collection, iconButtonClass, fallback }: {
  document?: DocumentActions;
  media?: MediaActionProps;
  collection?: DocumentTitlebarProps['collectionDisplay'];
  iconButtonClass: string;
  fallback?: ReactNode;
}) {
  const collectionContext = collection ? { ...collection,
    notebookPath: collection.notebookPath ?? document?.target.scopePath,
    notebookId: collection.notebookId ?? document?.target.notebookId,
  } : null;
  if (media) return <MediaActions {...media} iconButtonClass={iconButtonClass} collectionDisplay={collectionContext} />;
  if (document) return <>
    <ExternalTitlebarBadge target={document.target} />
    <ExternalDocumentActions key={`${document.target.fileIdentity.displayId}:${document.target.fileIdentity.path}`} {...document} iconButtonClass={iconButtonClass} collectionDisplay={collectionContext} />
  </>;
  if (collectionContext) return <CollectionDisplayMenu {...collectionContext} iconButtonClass={iconButtonClass} />;
  return fallback;
}
