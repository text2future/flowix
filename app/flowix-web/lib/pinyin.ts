// pinyin-pro 动态 import (独立 chunk, ~316KB)。
// property-key.generatePropertyKey 在创建属性时调用 ensurePinyin，保证中文属性名
// 生成正确拼音 key (降级会退化为 'property' 造成冲突)。

type PinyinFn = typeof import('pinyin-pro')['pinyin'];

let pinyinPromise: Promise<PinyinFn> | null = null;
let pinyinLoaded: PinyinFn | null = null;

/** 异步加载 pinyin-pro (已加载则立即 resolve), 返回 pinyin 函数。 */
export function ensurePinyin(): Promise<PinyinFn> {
  if (pinyinLoaded) return Promise.resolve(pinyinLoaded);
  if (!pinyinPromise) {
    pinyinPromise = import('pinyin-pro').then((module) => {
      pinyinLoaded = module.pinyin;
      return module.pinyin;
    });
  }
  return pinyinPromise;
}

export type { PinyinFn };
