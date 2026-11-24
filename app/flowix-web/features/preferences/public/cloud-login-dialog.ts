import type { Root } from 'react-dom/client';

/** Mount the shared account login dialog over the current window on demand. */
interface MountedCloudLoginDialog {
  container: HTMLElement;
  root: Root;
}

let mounted: MountedCloudLoginDialog | null = null;

export async function openCloudLoginDialog(): Promise<void> {
  if (typeof document === 'undefined') return;
  if (mounted) return;

  const [{ createRoot }, React, { CloudLoginDialog }] = await Promise.all([
    import('react-dom/client'),
    import('react'),
    import('../components/cloud-login-dialog'),
  ]);
  if (mounted) return;

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

  mounted = { container, root };
  root.render(React.createElement(CloudLoginDialog, { onClose: close }));
}

/** Test seam: true while the dialog is mounted. */
export function isCloudLoginDialogOpen(): boolean {
  return mounted !== null;
}
