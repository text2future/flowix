import zhCNMessages from './messages.zh-CN';
import fileTreeZhCN from './messages.file-tree.zh-CN';
import piSettingsZhCN from './messages.pi-settings.zh-CN';
import preferencesNoteZhCN from './messages.preferences-note.zh-CN';
import collectionZhCN from './messages.collection.zh-CN';
import propertyIconsZhCN from './messages.property-icons.zh-CN';
import editorTablesZhCN from './messages.editor-tables.zh-CN';
import editorSearchZhCN from './messages.editor-search.zh-CN';

export const APP_LANGUAGES = ["zh-CN", "en-US"] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_APP_LANGUAGE = "zh-CN" satisfies AppLanguage;

export const LANGUAGE_OPTIONS: { value: AppLanguage; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
];

export function sanitizeAppLanguage(value: unknown): AppLanguage {
  return APP_LANGUAGES.includes(value as AppLanguage)
    ? (value as AppLanguage)
    : DEFAULT_APP_LANGUAGE;
}

// i18n 按语言分包: 默认语言 zh-CN eager (进主 bundle), en-US 动态 import
// (独立 chunk, 切换时加载)。translate / useI18n 始终同步读 getMessages(lang),
// 未加载的语言回退到默认语言; I18nProvider 在 language 变化时触发 loadLanguage
// 并在就绪后重渲染。
//
// 主表 (messages.zh-CN / messages.en-US) 被千行闸门冻结, 新增文案放分片 (如
// messages.file-tree.*) 后与主表合并。I18nKey 从合并结果派生; 主表与分片各自用
// Record<...> 约束 key 集合一致, en-US 合并后再按 MessageMap 校验一次完整性。
const zhCN = { ...zhCNMessages, ...fileTreeZhCN, ...piSettingsZhCN, ...preferencesNoteZhCN, ...collectionZhCN, ...propertyIconsZhCN, ...editorTablesZhCN, ...editorSearchZhCN };

export type I18nKey = keyof typeof zhCN;
export type MessageMap = Record<I18nKey, string>;

const loadedMessages: Partial<Record<AppLanguage, MessageMap>> = {
  "zh-CN": zhCN,
};

let enUSPromise: Promise<MessageMap> | null = null;

/** 同步读取某语言消息表; 未加载时回退到默认语言 (zh-CN)。 */
export function getMessages(lang: AppLanguage): MessageMap {
  return loadedMessages[lang] ?? loadedMessages[DEFAULT_APP_LANGUAGE]!;
}

/** 该语言消息表是否已就绪 (默认语言始终 true)。 */
export function isLanguageLoaded(lang: AppLanguage): boolean {
  return lang === DEFAULT_APP_LANGUAGE || loadedMessages[lang] !== undefined;
}

/** 异步加载某语言消息表 (已加载则立即 resolve); 默认语言无需加载。 */
export function loadLanguage(lang: AppLanguage): Promise<MessageMap> {
  if (lang === DEFAULT_APP_LANGUAGE) {
    return Promise.resolve(zhCN as MessageMap);
  }
  const cached = loadedMessages[lang];
  if (cached) return Promise.resolve(cached);
  if (lang === "en-US") {
    if (!enUSPromise) {
      enUSPromise = Promise.all([
        import('./messages.en-US'),
        import('./messages.file-tree.en-US'),
        import('./messages.pi-settings.en-US'),
        import('./messages.preferences-note.en-US'),
        import('./messages.collection.en-US'),
        import('./messages.property-icons.en-US'),
        import('./messages.editor-tables.en-US'),
        import('./messages.editor-search.en-US'),
      ]).then(([module, fileTree, piSettings, preferencesNote, collection, propertyIcons, editorTables, editorSearch]) => {
        const msgs: MessageMap = { ...module.default, ...fileTree.default, ...piSettings.default, ...preferencesNote.default, ...collection.default, ...propertyIcons.default, ...editorTables.default, ...editorSearch.default };
        loadedMessages["en-US"] = msgs;
        return msgs;
      });
    }
    return enUSPromise;
  }
  return Promise.resolve(zhCN as MessageMap);
}
