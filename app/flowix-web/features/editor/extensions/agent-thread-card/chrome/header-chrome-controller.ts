import type { EditorView } from "@tiptap/pm/view";
import {
  cancelBlockDragForView,
  dropBlockDragAtForView,
  startBlockDragForView,
  updateBlockDragPositionForView,
} from "@features/editor/extensions/block-drag";
import {
  getEventElement,
  isAgentThreadCardInteractiveTarget,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";

interface HeaderDragState {
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
}

export interface AgentThreadCardHeaderChromeControllerOptions {
  dom: HTMLElement;
  header: HTMLDivElement;
  view: EditorView;
  getPos: () => number | undefined;
  getNodeSize: () => number;
  isFullscreen: () => boolean;
  closeTransientUi: () => void;
  dragThresholdPx: number;
}

export class AgentThreadCardHeaderChromeController {
  private readonly dom: HTMLElement;
  private readonly header: HTMLDivElement;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly getNodeSize: () => number;
  private readonly isFullscreen: () => boolean;
  private readonly closeTransientUi: () => void;
  private readonly dragThresholdPx: number;
  private dragState: HeaderDragState | null = null;
  private suppressNextHeaderClick = false;

  constructor(options: AgentThreadCardHeaderChromeControllerOptions) {
    this.dom = options.dom;
    this.header = options.header;
    this.view = options.view;
    this.getPos = options.getPos;
    this.getNodeSize = options.getNodeSize;
    this.isFullscreen = options.isFullscreen;
    this.closeTransientUi = options.closeTransientUi;
    this.dragThresholdPx = options.dragThresholdPx;
  }

  attach(): void {
    this.header.addEventListener("pointerdown", this.handlePointerDown);
    this.header.addEventListener("pointermove", this.handlePointerMove);
    this.header.addEventListener("pointerup", this.handlePointerUp);
    this.header.addEventListener("pointercancel", this.handlePointerCancel);
    this.header.addEventListener("click", this.handleClick, true);
  }

  dispose(): void {
    this.header.removeEventListener("pointerdown", this.handlePointerDown);
    this.header.removeEventListener("pointermove", this.handlePointerMove);
    this.header.removeEventListener("pointerup", this.handlePointerUp);
    this.header.removeEventListener("pointercancel", this.handlePointerCancel);
    this.header.removeEventListener("click", this.handleClick, true);
    if (this.dragState) {
      cancelBlockDragForView(this.view);
      this.releasePointerCapture(this.dragState.pointerId);
      this.dragState = null;
      this.dom.classList.remove("agent-thread-card--dragging");
    }
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.isFullscreen()) return;
    const target = getEventElement(event);
    if (!target || !this.header.contains(target)) return;
    if (isAgentThreadCardInteractiveTarget(target)) return;
    if (target.closest(".agent-thread-card__title")) return;

    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    this.header.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < this.dragThresholdPx) return;
      const pos = this.getPos();
      if (pos === undefined) {
        this.dragState = null;
        this.releasePointerCapture(event.pointerId);
        return;
      }
      if (
        !startBlockDragForView(this.view, {
          pos,
          nodeSize: this.getNodeSize(),
        })
      ) {
        this.dragState = null;
        this.releasePointerCapture(event.pointerId);
        return;
      }
      drag.started = true;
      this.dom.classList.add("agent-thread-card--dragging");
      this.closeTransientUi();
    }

    updateBlockDragPositionForView(this.view, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.dragState = null;
    if (drag.started) {
      dropBlockDragAtForView(this.view, event.clientX, event.clientY);
      this.finishDragInteraction();
      event.preventDefault();
      event.stopPropagation();
    }
    this.releasePointerCapture(event.pointerId);
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.dragState = null;
    if (drag.started) {
      cancelBlockDragForView(this.view);
      this.finishDragInteraction();
      event.preventDefault();
      event.stopPropagation();
    }
    this.releasePointerCapture(event.pointerId);
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (!this.suppressNextHeaderClick) return;
    this.suppressNextHeaderClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  private releasePointerCapture(pointerId: number): void {
    if (this.header.hasPointerCapture(pointerId)) {
      this.header.releasePointerCapture(pointerId);
    }
  }

  private finishDragInteraction(): void {
    this.dom.classList.remove("agent-thread-card--dragging");
    this.suppressNextHeaderClick = true;
    window.setTimeout(() => {
      this.suppressNextHeaderClick = false;
    }, 0);
  }
}
