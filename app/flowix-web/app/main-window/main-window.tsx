import { lazy, Suspense } from 'react';
import { useMainWindowBusinessController } from './use-main-window-business-controller';
import { useMainWindowSystemController } from './use-main-window-system-controller';

const MainLayout = lazy(() =>
  import('@features/shell').then((module) => ({ default: module.MainLayout })),
);

export function MainWindow() {
  const business = useMainWindowBusinessController();
  const system = useMainWindowSystemController();
  return (
    <Suspense fallback={null}>
      <MainLayout business={business} system={system} />
    </Suspense>
  );
}
