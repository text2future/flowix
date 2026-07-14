import { lazy, Suspense } from 'react';

interface LazyGlobalSearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const GlobalSearchCommand = lazy(() =>
  import('@features/shell').then((module) => ({
    default: module.GlobalSearchCommand,
  })),
);

export function LazyGlobalSearchCommand(props: LazyGlobalSearchCommandProps) {
  if (!props.open) return null;

  return (
    <Suspense fallback={null}>
      <GlobalSearchCommand {...props} />
    </Suspense>
  );
}
