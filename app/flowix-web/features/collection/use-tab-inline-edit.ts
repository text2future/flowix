import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * tab 条上的「就地改名输入框」状态。
 *
 * 一条 tab 条里同一时刻只允许一个输入框：表格视图 tab 与宿主 tab 虽然由两处渲染，
 * 但共用这一个实例（宿主 tab 用 `host:` 前缀的 id），所以它必须是单例——两边各持
 * 一份就可能同时开出两个输入框。
 *
 * 宽度取原 tab 宽度（双击 / 右键时由调用方量好传入），不随输入内容变宽。
 */
export interface TabInlineEdit {
  /** 正在改名的是谁：表格视图 id，或 `host:${宿主 tab key}`。 */
  editingId: string | null;
  name: string;
  setName: (name: string) => void;
  width: number;
  inputRef: RefObject<HTMLInputElement | null>;
  begin: (id: string, label: string, tabWidth?: number) => void;
  end: () => void;
}

const MIN_INPUT_WIDTH = 40;
const DEFAULT_INPUT_WIDTH = 48;

export function useTabInlineEdit(): TabInlineEdit {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [width, setWidth] = useState(DEFAULT_INPUT_WIDTH);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (!editingId) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingId]);

  const begin = useCallback((id: string, label: string, tabWidth?: number) => {
    setName(label);
    setWidth(tabWidth ? Math.max(MIN_INPUT_WIDTH, Math.ceil(tabWidth)) : DEFAULT_INPUT_WIDTH);
    setEditingId(id);
  }, []);

  const end = useCallback(() => setEditingId(null), []);

  return { editingId, name, setName, width, inputRef, begin, end };
}
