'use client';

import { useCallback, useMemo, useState } from 'react';

/**
 * tab 条「···」→ 添加视图的向导状态。
 *
 * 「添加视图」是一个四步状态机：类型 → 选字段 → 保存 → 收起。它牵动的东西只有一个
 * 弹层（`···` 菜单），却要在表格里同时被四五个建视图流程改写（建表格 / 画廊 /
 * 日历 / 看板、给已有视图换分组字段）。之前这些状态以六个 `useState` 散落在
 * 表格组件里、再把一整套 `xxx` / `onXxxChange` 成对透传给菜单，改一处要动三处。
 *
 * 现在收敛成一个对象：状态只读、动作是语义化的（`chooseType` / `configureView` /
 * `close`），菜单与表格都只跟它对话，不再互相知道对方的字段名。
 *
 * 「收起即复位」是不变的约定：弹层任何一次关闭都回到「选择视图类型」，
 * 所以打开时永远不需要额外复位，也就不会出现「上次选了看板，这次打开还停在看板」。
 */
export type ViewAddStep = 'kind' | 'field' | 'manage';
export type ViewAddKind = 'calendar' | 'kanban';

export interface ViewAddWizard {
  open: boolean;
  step: ViewAddStep;
  /** 正在选字段的视图类型；null = 当前还没选类型。 */
  pendingType: ViewAddKind | null;
  /** 非空 = 给**已存在的视图**换分组字段，而不是新建视图。 */
  configuringViewId: string | null;
  /** 换字段时把弹层钉回触发按钮（tab 上的类型切换入口）；null = 贴「···」按钮。 */
  anchorRect: DOMRect | null;
  /** 打开 / 收起弹层；收起时复位。 */
  setOpen: (open: boolean) => void;
  /** 收起并复位（视图建好、保存成功后调用）。 */
  close: () => void;
  setStep: (step: ViewAddStep) => void;
  /** 选「日历 / 看板」：从类型列表进到选字段。 */
  chooseType: (type: ViewAddKind) => void;
  /** 从选字段退回类型列表。 */
  backToKinds: () => void;
  /** 给已有视图换分组字段：直接进选字段，并把弹层钉在触发按钮上。 */
  configureView: (viewId: string, type: ViewAddKind, anchorRect: DOMRect) => void;
  setAnchorRect: (rect: DOMRect | null) => void;
}

export function useViewAddWizard({ onClose }: { onClose?: () => void } = {}): ViewAddWizard {
  const [open, setOpenState] = useState(false);
  const [step, setStep] = useState<ViewAddStep>('kind');
  const [pendingType, setPendingType] = useState<ViewAddKind | null>(null);
  const [configuringViewId, setConfiguringViewId] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const close = useCallback(() => {
    setOpenState(false);
    setStep('kind');
    setPendingType(null);
    setConfiguringViewId(null);
    setAnchorRect(null);
    onClose?.();
  }, [onClose]);

  const setOpen = useCallback((next: boolean) => {
    if (next) {
      setOpenState(true);
      return;
    }
    close();
  }, [close]);

  const chooseType = useCallback((type: ViewAddKind) => {
    setConfiguringViewId(null);
    setPendingType(type);
    setAnchorRect(null);
    setStep('field');
  }, []);

  const backToKinds = useCallback(() => {
    setStep('kind');
    setPendingType(null);
    setAnchorRect(null);
  }, []);

  const configureView = useCallback((viewId: string, type: ViewAddKind, rect: DOMRect) => {
    setConfiguringViewId(viewId);
    setPendingType(type);
    setAnchorRect(rect);
    setStep('field');
    setOpenState(true);
  }, []);

  return useMemo(() => ({
    open, step, pendingType, configuringViewId, anchorRect,
    setOpen, close, setStep, chooseType, backToKinds, configureView, setAnchorRect,
  }), [anchorRect, backToKinds, chooseType, close, configuringViewId, configureView, open, pendingType, setOpen, step]);
}
