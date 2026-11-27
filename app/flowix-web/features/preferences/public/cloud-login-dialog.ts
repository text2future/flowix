import type { Root } from 'react-dom/client';

/** Mount the shared account login dialog over the current window on demand. */
interface MountedCloudLoginDialog {
  container: HTMLElement;
  root: Root;
  onAuthenticated?: () => void;
}

let mounted: MountedCloudLoginDialog | null = null;

function getMountedDialog(): MountedCloudLoginDialog | null {
  return mounted;
}

export async function openCloudLoginDialog(onAuthenticated?: () => void): Promise<void> {
  if (typeof document === 'undefined') return;
  if (mounted) {
    if (onAuthenticated) mounted.onAuthenticated = onAuthenticated;
    return;
  }

  const [{ createRoot }, React, { CloudLoginDialog }] = await Promise.all([
    import('react-dom/client'),
    import('react'),
    import('../components/cloud-login-dialog'),
  ]);
  // Another caller may have mounted the dialog while the imports loaded.
  const current = getMountedDialog();
  if (current) {
    if (onAuthenticated) current.onAuthenticated = onAuthenticated;
    return;
  }

  const container = document.createElement('div');
  container.className = 'cloud-login-dialog-root';
  document.body.append(container);
  const root = createRoot(container);
  const close = () => {
    if (!mounted) return;
    mounted = null;
    root.unmount();
    container.remove();
  };

  mounted = { container, root, onAuthenticated };
  root.render(React.createElement(CloudLoginDialog, {
    onClose: close,
    onAuthenticated: () => mounted?.onAuthenticated?.(),
  }));
}

/** Test seam: true while the dialog is mounted. */
export function isCloudLoginDialogOpen(): boolean {
  return mounted !== null;
}
