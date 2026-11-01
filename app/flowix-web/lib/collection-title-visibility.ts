'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 集合名称的显示偏好（全局一条）。
 *
 * 一个集合只有**一个名字**，与内部有几个数据域、几个 tab 无关。名字由谁渲染取决于
 * 外壳：文件夹首页渲染在标题头（文件夹图标 + 名称），独立集合渲染在表格 nav 标题位。
 * 两处共用这条偏好与同一个事件，所以「···」菜单里的「显示标题」对两者行为一致。
 */
const TITLE_VISIBILITY_STORAGE_KEY = 'flowix:multidimensional-table:title-visible';
const TITLE_VISIBILITY_EVENT = 'flowix:multidimensional-table:title-visibility-changed';

function readTitleVisibility(): boolean {
  try {
    return window.localStorage.getItem(TITLE_VISIBILITY_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useCollectionTitleVisibility(): { titleVisible: boolean; toggleTitleVisibility: () => void } {
  const [titleVisible, setTitleVisible] = useState(true);
  useEffect(() => {
    const sync = () => setTitleVisible(readTitleVisibility());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TITLE_VISIBILITY_STORAGE_KEY || event.key === null) sync();
    };
    sync();
    window.addEventListener('storage', handleStorage);
    window.addEventListener(TITLE_VISIBILITY_EVENT, sync);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(TITLE_VISIBILITY_EVENT, sync);
    };
  }, []);
  const toggleTitleVisibility = useCallback(() => {
    const next = !readTitleVisibility();
    setTitleVisible(next);
    try {
      window.localStorage.setItem(TITLE_VISIBILITY_STORAGE_KEY, String(next));
      window.dispatchEvent(new Event(TITLE_VISIBILITY_EVENT));
    } catch {
      // 本地存储不可用时保持开关可用。
    }
  }, []);
  return { titleVisible, toggleTitleVisibility };
}
