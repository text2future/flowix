'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Selection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useState, useCallback, memo } from 'react';
import YAML from 'yaml';

interface FrontmatterViewProps {
  node: any;
  updateAttributes: (attrs: Record<string, unknown>) => void;
}

const FrontmatterView = memo(({ node, updateAttributes }: FrontmatterViewProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.attrs.yamlContent);

  const handleDoubleClick = useCallback(() => {
    setIsEditing(true);
    setEditValue(node.attrs.yamlContent);
  }, [node.attrs.yamlContent]);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    try {
      const parsed = YAML.parse(editValue) || {};
      updateAttributes({
        yamlContent: editValue,
        parsedData: parsed,
      });
    } catch (e) {
      setEditValue(node.attrs.yamlContent);
    }
  }, [editValue, updateAttributes, node.attrs.yamlContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(node.attrs.yamlContent);
    }
  }, [node.attrs.yamlContent]);

  return (
    <NodeViewWrapper>
      <div
        contentEditable={false}
        onDoubleClick={handleDoubleClick}
        style={{
          background: '#f5f5f5',
          border: '1px dashed #ccc',
          borderRadius: '4px',
          padding: '8px 12px',
          marginBottom: '8px',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
          lineHeight: '1.5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          cursor: 'pointer',
        }}
      >
        {isEditing ? (
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            autoFocus
            style={{
              width: '100%',
              minHeight: '60px',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              lineHeight: '1.5',
              border: '1px solid #3b82f6',
              borderRadius: '4px',
              padding: '4px 8px',
              background: 'white',
              color: '#333',
              resize: 'vertical',
              outline: 'none',
            }}
          />
        ) : (
          <code>{node.attrs.yamlContent || '(empty frontmatter)'}</code>
        )}
      </div>
    </NodeViewWrapper>
  );
});

const Frontmatter = Node.create({
  name: 'frontmatter',
  priority: 1000,
  group: 'block',
  defining: true,
  selectable: false,
  draggable: false,
  content: '',

  addStorage() {
    return { frontmatterMatched: false };
  },

  addAttributes() {
    return {
      yamlContent: {
        default: '',
      },
      parsedData: {
        default: {},
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(FrontmatterView, {
      stopEvent: () => true,
    });
  },

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => selectBodyContent(this.editor, this.name),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('frontmatter-protection'),
        appendTransaction: (_transactions, _oldState, newState) => {
          const firstNode = newState.doc.firstChild;
          if (firstNode?.type.name !== this.name) return null;

          if (!selectionIncludesFrontmatter(newState.selection, firstNode.nodeSize)) {
            return null;
          }

          return newState.tr.setSelection(
            createSelectionAfterFrontmatter(newState.doc, firstNode.nodeSize)
          );
        },
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged) return true;

          const currentFirstNode = state.doc.firstChild;
          if (currentFirstNode?.type.name !== this.name) return true;

          return transaction.doc.firstChild?.type.name === this.name;
        },
      }),
    ];
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="frontmatter"]',
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          return {
            yamlContent: element.getAttribute('data-yaml-content') || '',
            parsedData: element.getAttribute('data-parsed-data')
              ? JSON.parse(element.getAttribute('data-parsed-data')!)
              : {},
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(
        { 'data-type': 'frontmatter' },
        { 'data-yaml-content': node.attrs.yamlContent },
        { 'data-parsed-data': JSON.stringify(node.attrs.parsedData) },
        HTMLAttributes
      ),
    ];
  },

  markdownTokenizer: {
    name: 'frontmatter',
    level: 'block',
    start(src: string) {
      return src.startsWith('---') ? 0 : -1;
    },
    tokenize(src: string, tokens?: any[]): any {
      if (tokens && tokens.length > 0) return undefined;

      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: 'frontmatter', raw: match[0] };
    },
  },

  parseMarkdown(token: any) {
    const raw = token.raw;
    const yamlMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!yamlMatch) {
      return { type: 'text', text: raw };
    }

    const yamlContent = yamlMatch[1].trim();
    let parsedData: Record<string, unknown> = {};

    try {
      const raw = YAML.parse(yamlContent) || {};
      // `key` 是后端权威字段, 走 frontmatter 的 `key` 行注入。
      // UI 不暴露给用户编辑, parsedData 里剥掉避免误显示在编辑面板。
      const { key: _ignored, ...rest } = raw as Record<string, unknown>;
      parsedData = rest;
    } catch (e) {
      console.warn('[Frontmatter] Failed to parse YAML:', e);
    }

    const storage = (this as any).storage;
    if (storage?.frontmatter) {
      storage.frontmatterMatched = true;
    }

    return {
      type: 'frontmatter',
      attrs: {
        yamlContent,
        parsedData,
      },
    };
  },

  renderMarkdown(node, _helpers) {
    const yamlContent = node.attrs?.yamlContent || '';
    return `---\n${yamlContent}\n---\n`;
  },
});

function selectBodyContent(editor: Editor, frontmatterNodeName: string) {
  const { state, view } = editor;
  const firstNode = state.doc.firstChild;

  if (firstNode?.type.name !== frontmatterNodeName) return false;

  view.dispatch(
    state.tr
      .setSelection(createSelectionAfterFrontmatter(state.doc, firstNode.nodeSize))
      .scrollIntoView()
  );

  return true;
}

function selectionIncludesFrontmatter(selection: Selection, frontmatterEnd: number) {
  return (
    selection instanceof AllSelection ||
    (!selection.empty && selection.from < frontmatterEnd && selection.to > 0)
  );
}

function createSelectionAfterFrontmatter(doc: ProseMirrorNode, frontmatterEnd: number) {
  const to = doc.content.size;
  const $from = doc.resolve(Math.min(frontmatterEnd, to));
  const $to = doc.resolve(to);

  return frontmatterEnd < to
    ? TextSelection.between($from, $to, 1)
    : TextSelection.near($to, -1);
}

export default Frontmatter;
