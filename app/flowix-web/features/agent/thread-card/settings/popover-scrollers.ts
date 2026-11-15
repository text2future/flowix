import { createPopupScrollAreaDom } from '@shared/ui/popup-scroll-area-dom';
import type { OverlayScrollbarDomController } from '@shared/ui/overlay-scrollbar-dom';

/**
 * 设置浮层里的两处自绘滚动条：正文与外层的模型选择列表。
 *
 * 两者互斥 —— 模型选择列表一打开，正文滚动条必须拆掉，否则同一块浮层上叠两层
 * 滚动容器。这条互斥规则原来散在控制器的四个私有方法里，收进这里之后控制器只剩
 * 「什么时候换内容」，不用再管 DOM 生命周期。
 */
export class PopoverScrollers {
  private body: OverlayScrollbarDomController | null = null;
  private modelPicker: OverlayScrollbarDomController | null = null;

  constructor(private readonly host: HTMLDivElement) {}

  clearBody(): void {
    this.body?.destroy();
    this.body = null;
    this.host.classList.remove('popup-scroll-shell');
  }

  /** 把浮层现有子节点包进正文滚动壳；模型选择列表在场时不动。 */
  mountBody(): void {
    if (this.modelPicker || this.body) return;
    this.body = createPopupScrollAreaDom(this.host.ownerDocument);
    this.body.scroller.append(...this.host.childNodes);
    this.host.replaceChildren(this.body.frame);
    this.host.classList.add('popup-scroll-shell');
  }

  /** 重建模型选择列表的滚动条，返回可挂列表项的 scroller。 */
  createModelPicker(typeKey: string): HTMLDivElement {
    this.clearModelPicker();
    this.modelPicker = createPopupScrollAreaDom(this.host.ownerDocument, {
      frameClassName: 'agent-thread-card__codex-settings-model-scroll-frame overlay-scrollbar-frame--custom-mac',
      scrollerClassName: [
        'agent-thread-card__codex-settings-model-scroll',
        typeKey !== 'pi' && typeKey !== 'codex'
          ? 'agent-thread-card__codex-settings-model-scroll--inset'
          : undefined,
      ].filter(Boolean).join(' '),
    });
    this.host.append(this.modelPicker.frame);
    return this.modelPicker.scroller;
  }

  clearModelPicker(): void {
    this.modelPicker?.destroy();
    this.modelPicker = null;
  }
}
