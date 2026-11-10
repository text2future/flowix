/**
 * 偏好窗口的 tab 配置，单独成入口。
 *
 * 这份配置包含每个 tab 的图标与分组，属于**偏好窗口自己的**渲染数据。
 * 它曾经被 `app-api.ts` re-export，于是应用根 import 任意一个 preferences hook
 * 都会把整份配置（连带 AgentIcon → lib/agent-types 那条链）拖进启动 chunk。
 * 需要它的只有偏好视图与笔记本图标菜单，不要让 app-api 再转出。
 */
export {
  PREFERENCE_TAB_GROUPS,
  PREFERENCE_TABS,
  type ActiveSettingsTab,
  type PreferencesTabGroup,
} from '@features/preferences/preferences-tab-config';
