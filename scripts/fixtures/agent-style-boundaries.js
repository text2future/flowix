import { createAgentComposerDom } from '../../app/flowix-web/features/agent/thread-card/composer/composer-dom-factory';
import { createInlineAtomCloseIcon, createInlineAtomNodeView } from '../../app/flowix-web/features/editor/extensions/shared/inline-atom-nodeview';
import { Editor, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { Plugin } from '@tiptap/pm/state';
import { createTerminalInlineAtomCaretDecorations } from '../../app/flowix-web/features/editor/extensions/shared/terminal-inline-atom-caret';
import '../../app/flowix-web/styles/theme/light.css';
import '../../app/flowix-web/styles/editor.css';
import '../../app/flowix-web/styles/editor-frontmatter.css';
import '../../app/flowix-web/styles/editor-note-reference.css';
import '../../app/flowix-web/styles/editor-attachment-link.css';
import '../../app/flowix-web/styles/editor-code-block.css';
import '../../app/flowix-web/styles/agent-conversation.css';

const report = document.querySelector('#agent-style-result');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const properties = ['display', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'textAlign', 'textIndent', 'color', 'padding', 'margin', 'border', 'borderRadius',
  'whiteSpace', 'wordBreak', 'overflowWrap', 'userSelect', 'transform', 'visibility'];
const snapshot = element => {
  const style = getComputedStyle(element);
  return Object.fromEntries(properties.map(key => [key, key === 'textAlign' && style[key] === 'start' ? (style.direction === 'rtl' ? 'right' : 'left') : style[key]]));
};
// Use the product's mount contract so paragraph selectors match the app.
function checkTerminalChipLayout(mode) {
  const root = document.createElement('section');
  root.className = 'agent-conversation-surface';
  root.style.width = '700px';
  const parts = createAgentComposerDom({ variant: mode === 'inline' ? 'compact' : 'expanded', t: key => key });
  root.append(parts.composer);
  document.body.append(root);
  const chip = Node.create({
    name: 'layoutProbeChip', group: 'inline', inline: true, atom: true,
    renderHTML: () => ['span', 'Reference'],
    addNodeView: () => () => createInlineAtomNodeView({
      wrapperClassName: 'agent-composer__inline-atom-wrapper', label: 'Reference',
    }),
    addProseMirrorPlugins: () => [new Plugin({
      props: { decorations: state => createTerminalInlineAtomCaretDecorations(state.doc, ['layoutProbeChip']) },
    })],
  });
  const editor = new Editor({
    element: { mount: parts.input },
    extensions: [Document, Paragraph, Text, HardBreak, chip],
    editorProps: { attributes: { class: 'agent-composer__input-content' } },
  });
  parts.input.classList.add('agent-composer__input', 'agent-composer__input-content');
  try {
    check(editor.view.dom === parts.input, 'Composer probe has an extra editor wrapper');
    const measure = content => {
      editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content }] });
      const paragraph = parts.input.querySelector('p');
      const trailingBreak = paragraph.querySelector('br.ProseMirror-trailingBreak');
      return {
        paragraph: paragraph.getBoundingClientRect().height,
        composer: parts.composer.getBoundingClientRect().height,
        breakHidden: trailingBreak && getComputedStyle(trailingBreak).display === 'none',
      };
    };
    const atom = { type: 'layoutProbeChip' };
    const bare = measure([atom]);
    check(bare.breakHidden, 'Terminal chip compensation break is visible in ' + mode);
    for (const text of [' ', '  ', 'text']) {
      const withText = measure([atom, { type: 'text', text }]);
      check(Math.abs(bare.paragraph - withText.paragraph) < 0.5 && Math.abs(bare.composer - withText.composer) < 0.5,
        'Terminal chip height changes with adjacent text in ' + mode);
    }
    const empty = measure([]);
    check(!empty.breakHidden && empty.paragraph > 0, 'Empty composer lost its line box in ' + mode);
    const newline = measure([atom, { type: 'hardBreak' }]);
    check(!newline.breakHidden && newline.paragraph > bare.paragraph + 1, 'Explicit composer newline is hidden in ' + mode);
  } finally {
    editor.destroy();
    root.remove();
    for (const popover of [parts.codexSettingsPopover, parts.composerAddPopover, parts.composerRolePopover]) popover.remove();
  }
}

function makeSurface(mode, editorHost) {
  const root = document.createElement('section');
  root.className = mode === 'standalone'
    ? 'agent-conversation-surface agent-conversation-detail'
    : `agent-conversation-surface agent-thread-card ${mode === 'fullscreen' ? 'agent-thread-card--fullscreen' : ''}`;
  root.style.cssText = 'width:900px;height:650px;--atc-fullscreen-width:900px;--atc-fullscreen-height:650px';
  let card = root;
  if (mode === 'standalone') {
    card = document.createElement('div');
    card.className = 'agent-thread-card agent-conversation-detail__card flex min-h-0 flex-1 flex-col';
    root.append(card);
  } else {
    card = document.createElement('div');
    card.className = 'agent-thread-card__container';
    root.append(card);
    const header = document.createElement('div');
    header.className = 'agent-thread-card__header';
    card.append(header);
  }
  const body = document.createElement('div');
  body.className = 'agent-thread-card__body';
  if (mode === 'standalone') {
    const shell = document.createElement('div');
    shell.className = 'agent-conversation-detail__body-shell';
    shell.append(body); card.append(shell);
  } else card.append(body);
  body.innerHTML = `<div class="agent-thread-card__messages"><article class="agent-thread-card__message agent-thread-card__message--assistant"><div class="agent-thread-card__message-content"><h2>Heading</h2><p>Message text</p><ul><li>Item</li></ul><table><tbody><tr><td>Cell</td></tr></tbody></table><a href="#">Link</a><code>code</code></div></article></div>`;
  const loading = document.createElement('div');
  loading.className = 'agent-thread-card__loading-indicator';
  loading.setAttribute('role', 'status');
  loading.innerHTML = '<span class="agent-thread-card__loading-cells"><span class="agent-thread-card__loading-cell"></span></span><span class="agent-thread-card__loading-text">运行中</span>';
  body.append(loading);
  const parts = createAgentComposerDom({ variant: mode === 'inline' ? 'compact' : 'expanded', t: key => key });
  parts.input.classList.add('tiptap', 'ProseMirror', 'agent-composer__input-content');
  const paragraph = document.createElement('p');
  parts.input.append(paragraph);
  const note = document.createElement('span');
  note.className = 'note-reference__card';
  note.innerHTML = '<span class="note-reference__icon">N</span><span class="note-reference__name"><span class="note-reference__title">A long referenced note title</span></span>';
  let removed = false;
  const atom = createInlineAtomNodeView({
    wrapperClassName: 'editor-note-reference agent-composer__note-reference agent-composer__inline-atom-wrapper',
    content: note,
    hoverActions: [{ ariaLabel: 'Remove note', icon: createInlineAtomCloseIcon(), onClick: () => { removed = true; atom.dom.remove(); } }],
  });
  paragraph.append(atom.dom);
  atom.dom.classList.add('is-selected');
  card.append(parts.composer);
  (editorHost ?? document.body).append(root);
  const tracked = [note, note.querySelector('.note-reference__title'), atom.dom.querySelector('button'), paragraph,
    ...body.querySelector('.agent-thread-card__message-content').children];
  return { root, note, tracked, loading, atom, removed: () => removed, body, composer: parts.composer };
}
try {
  const documentHost = document.createElement('div');
  documentHost.className = 'markdown-editor';
  documentHost.innerHTML = '<div class="tiptap ProseMirror"><p id="document-paragraph">Document text</p><span class="editor-note-reference"><span class="note-reference__card">Document reference</span></span></div>';
  document.body.append(documentHost);
  const outerEditor = documentHost.querySelector('.tiptap');
  const standalone = makeSurface('standalone');
  const fullscreen = makeSurface('fullscreen', outerEditor);
  const inline = makeSurface('inline', outerEditor);
  const values = surface => surface.tracked.map(snapshot);
  check(JSON.stringify(values(fullscreen)) === JSON.stringify(values(standalone)), 'Fullscreen content or remove button differs from standalone');
  check(JSON.stringify(fullscreen.tracked.slice(0, 3).map(snapshot)) === JSON.stringify(inline.tracked.slice(0, 3).map(snapshot)), 'Inline references differ from expanded references');
  const before = [values(standalone), values(fullscreen), values(inline)];
  const documentBefore = getComputedStyle(document.querySelector('#document-paragraph')).fontSize;
  outerEditor.style.cssText = 'font-family:serif;font-size:32px;line-height:3;font-weight:900;font-style:italic;letter-spacing:4px;text-align:right;text-indent:40px;color:red;--editor-font-size:32px;--editor-line-height:3';
  check(getComputedStyle(document.querySelector('#document-paragraph')).fontSize !== documentBefore, 'Document typography did not change');
  check(JSON.stringify(before) === JSON.stringify([values(standalone), values(fullscreen), values(inline)]), 'Document typography leaked into Agent content');
  check(getComputedStyle(document.querySelector('.editor-note-reference > .note-reference__card')).borderTopStyle === 'none', 'Document reference styling was lost');
  for (const surface of [standalone, fullscreen]) {
    const contentWidth = surface.body.querySelector('.agent-thread-card__messages').getBoundingClientRect().width;
    check(Math.abs(contentWidth - 780) < 1, 'Expanded message column has wrong width: ' + contentWidth + ' in ' + surface.root.className + ', root=' + surface.root.getBoundingClientRect().width + ', body=' + surface.body.getBoundingClientRect().width);
    check(Math.abs(surface.composer.getBoundingClientRect().width - contentWidth) < 1, 'Composer and message column do not align');
  }
  for (const surface of [standalone, fullscreen, inline]) {
    const messageBounds = surface.body.querySelector('.agent-thread-card__messages').getBoundingClientRect();
    const loadingBounds = surface.loading.getBoundingClientRect();
    check(Math.abs(loadingBounds.left - messageBounds.left) < 1 && Math.abs(loadingBounds.width - messageBounds.width) < 1, 'Running status does not share the message column');
    check(Math.abs(surface.loading.firstElementChild.getBoundingClientRect().left - messageBounds.left) < 1, 'Running status is not aligned to the start of the message column');
    const button = surface.atom.dom.querySelector('button');
    check(getComputedStyle(button.parentElement).visibility === 'visible', 'Selected reference has no remove action');
    button.click();
    check(surface.removed() && !surface.note.isConnected, 'Remove action failed');
  }
  // Exercise the real CSS cascade: compact/expanded composers and macOS
  // scroll wrappers must all disappear at the inline card boundary.
  const inlineContainer = inline.root.querySelector('.agent-thread-card__container');
  const queued = document.createElement('div');
  queued.className = 'agent-background-terminals agent-thread-card__queued-messages';
  queued.textContent = 'Queued prompt';
  inlineContainer.insertBefore(queued, inline.composer);
  const frame = document.createElement('div');
  frame.className = 'agent-thread-card__body-frame overlay-scrollbar-frame--custom-mac';
  inline.body.before(frame);
  frame.append(inline.body);
  for (const platform of ['mac', 'windows']) {
    document.documentElement.dataset.platform = platform;
    for (const expanded of [false, true]) {
      inline.composer.classList.toggle('agent-composer--expanded', expanded);
      inline.root.classList.add('agent-thread-card--collapsed');
      check(getComputedStyle(inlineContainer.firstElementChild).display !== 'none', 'Collapsed header is hidden');
      for (const child of [frame, queued, inline.composer]) {
        check(getComputedStyle(child).display === 'none' && child.getClientRects().length === 0,
          'Collapsed card leaks content: ' + child.className + ' on ' + platform);
      }
      inline.root.classList.remove('agent-thread-card--collapsed');
      check(getComputedStyle(inline.composer).display !== 'none', 'Expanding did not restore composer');
    }
  }
  delete document.documentElement.dataset.platform;
  fullscreen.root.classList.add('agent-thread-card--collapsed');
  check(getComputedStyle(fullscreen.body).display !== 'none' && getComputedStyle(fullscreen.composer).display !== 'none',
    'Persisted inline collapse hides fullscreen conversation');
  fullscreen.root.classList.remove('agent-thread-card--collapsed');
  // A card that is the first *visible* block must get the same 0.8rem offset as
  // a first paragraph or code block. The document is preceded by a collapsed
  // frontmatter node, which used to be counted as "block 1" and left a leading
  // card flush against the titlebar.
  const firstBlockHost = document.createElement('div');
  firstBlockHost.className = 'tiptap ProseMirror';
  const frontmatter = document.createElement('div');
  frontmatter.className = 'frontmatter-property-node';
  frontmatter.dataset.visible = 'false';
  const leadingCard = document.createElement('section');
  // The real editor's first-block extension supplies this class.
  leadingCard.className = 'agent-thread-card agent-conversation-surface editor-leading-block';
  leadingCard.contentEditable = 'false';
  const leadingContainer = document.createElement('div');
  leadingContainer.className = 'agent-thread-card__container';
  leadingCard.append(leadingContainer);
  const gapCursor = document.createElement('div');
  gapCursor.className = 'ProseMirror-gapcursor';
  firstBlockHost.append(frontmatter, gapCursor, leadingCard);
  documentHost.append(firstBlockHost);
  const expectedOffset = 0.8 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  const leadingOffset = parseFloat(getComputedStyle(leadingCard).marginTop);
  check(
    Math.abs(leadingOffset - expectedOffset) < 0.5,
    'Leading card lost its first-block offset: ' + leadingOffset + 'px, expected ' + expectedOffset + 'px',
  );
  // The insertion caret is anchored to the flow position (= the card's margin
  // edge), so it must be pulled back down by the same offset; otherwise it
  // floats 0.8rem higher than the 5px it keeps between two blocks.
  const caretTop = parseFloat(getComputedStyle(gapCursor, '::after').top);
  check(
    Math.abs(caretTop - (expectedOffset - 5)) < 0.5,
    'Insertion caret above a leading card is not compensated: ' + caretTop + 'px, expected ' + (expectedOffset - 5) + 'px',
  );
  // The same compensation must cover any other first non-text block (a code
  // block, a table, an image) — the rule keys off "first block", not the card.
  const codeHost = document.createElement('div');
  codeHost.className = 'tiptap ProseMirror';
  const codeGapCursor = document.createElement('div');
  codeGapCursor.className = 'ProseMirror-gapcursor';
  const codeWrapper = document.createElement('div');
  codeWrapper.className = 'code-block-wrapper editor-first-block editor-leading-block';
  const codeContent = document.createElement('pre');
  codeContent.className = 'code-block-content';
  codeWrapper.append(codeContent);
  codeHost.append(codeGapCursor, codeWrapper);
  documentHost.append(codeHost);
  const codeCaretTop = parseFloat(getComputedStyle(codeGapCursor, '::after').top);
  check(
    Math.abs(codeCaretTop - (expectedOffset - 5)) < 0.5,
    'Insertion caret above a leading code block is not compensated: ' + codeCaretTop + 'px, expected ' + (expectedOffset - 5) + 'px',
  );
  for (const mode of ['standalone', 'fullscreen', 'inline']) checkTerminalChipLayout(mode);
  report.textContent = JSON.stringify({ ok: true, cases: ['standalone', 'fullscreen', 'inline'], checks: ['shared references and remove buttons', 'message typography', 'document typography isolation', 'expanded column widths', 'left-aligned running status', 'remove interaction', 'first-block offset', 'insertion caret offset', 'collapsed card content isolation', 'fullscreen collapse isolation', 'terminal chip spacing and explicit newlines'] });
} catch (error) {
  report.textContent = JSON.stringify({ ok: false, error: String(error.stack ?? error) });
}
