import { createRoot } from 'react-dom/client';

import {
  AgentThreadCardMessagesController,
  type AgentThreadCardMessagesControllerOptions,
} from '@features/agent/thread-card/messages';
import {
  ComposerController,
  type ComposerControllerOptions,
} from '@features/agent/thread-card/composer';

type SurfaceMessageOptions = Omit<
  AgentThreadCardMessagesControllerOptions,
  'dom' | 'body' | 'loadingIndicator'
>;
type SurfaceComposerOptions = Omit<
  ComposerControllerOptions,
  'input' | 'composer' | 'sendButtonRoot' | 'initialDraft'
>;

/**
 * Shared interactive core for a thread conversation.
 *
 * The surrounding host decides how title/role/draft attributes are persisted:
 * a Tiptap NodeView writes node attrs, while the independent detail writes its
 * conversation instance. Message history and composer event lifecycles are
 * identical and live here exactly once.
 */
export class AgentConversationSurfaceController {
  readonly messages: AgentThreadCardMessagesController;
  readonly composer: ComposerController;
  private readonly body: HTMLElement;
  private readonly input: HTMLDivElement;

  constructor(options: {
    dom: HTMLElement;
    body: HTMLElement;
    loadingIndicator: HTMLDivElement;
    composer: HTMLElement;
    input: HTMLDivElement;
    inputDraft: string;
    sendButtonMount: HTMLSpanElement;
    messageOptions: SurfaceMessageOptions;
    composerOptions: SurfaceComposerOptions;
  }) {
    this.body = options.body;
    this.input = options.input;
    this.messages = new AgentThreadCardMessagesController({
      dom: options.dom,
      body: options.body,
      loadingIndicator: options.loadingIndicator,
      ...options.messageOptions,
    });
    this.composer = new ComposerController({
      input: options.input,
      composer: options.composer,
      initialDraft: options.inputDraft,
      sendButtonRoot: createRoot(options.sendButtonMount),
      ...options.composerOptions,
    });
    this.body.addEventListener('pointerdown', this.blurComposerOnMessagePointerDown, true);
  }

  private readonly blurComposerOnMessagePointerDown = (event: PointerEvent): void => {
    if (event.button === 0 && document.activeElement === this.input) {
      this.input.blur();
    }
  };

  dispose(): void {
    this.body.removeEventListener('pointerdown', this.blurComposerOnMessagePointerDown, true);
    this.messages.dispose();
    this.composer.dispose();
  }
}
