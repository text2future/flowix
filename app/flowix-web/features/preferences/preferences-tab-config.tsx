import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import {
  CloudIcon,
  DotsThreeCircleIcon,
  FadersHorizontalIcon,
  InfoIcon,
  KeyboardIcon,
  ListChecksIcon,
  StarFourIcon,
  SwatchesIcon,
  TextAUnderlineIcon,
  UserIcon,
} from '@phosphor-icons/react';
import type { I18nKey } from '@/lib/i18n';
import mcpPluginIcon from '@/assets/mcp-plugin-settings.svg';
import { AgentIcon } from '@features/agent/public/icon-api';

export interface PreferenceTabProps {
  productInfo?: import('@platform/tauri/client').ProductInfo | null;
}

export type PreferenceTabComponent = LazyExoticComponent<ComponentType<PreferenceTabProps>>;
type PreferenceTabLoader = () => Promise<{ default: unknown }>;

function lazyPreferenceTab(load: PreferenceTabLoader) {
  const createComponent = () => lazy(async () => {
    const module = await load();
    return { default: module.default as ComponentType<PreferenceTabProps> };
  });
  return { createComponent };
}

export type PreferencesTabItem<Id extends string = string> = {
  id: Id;
  labelKey: I18nKey;
  icon: ReactNode;
  createComponent: () => PreferenceTabComponent;
  contentWidth: 'normal' | 'wide';
  experimentalOnly?: boolean;
  visibleInProductMenu?: boolean;
};

export type PreferencesTabGroup<Id extends string = string> = {
  labelKey: I18nKey;
  tabs: readonly PreferencesTabItem<Id>[];
};

/**
 * The preference sidebar, product menu, route normalization and page loader
 * all derive from these definitions. Dynamic imports keep inactive sections
 * out of the initial preference-window chunk.
 */
export const PREFERENCE_TAB_GROUPS = [
  {
    labelKey: 'preferences.groups.features',
    tabs: [
      {
        id: 'general', labelKey: 'preferences.tabs.general',
        icon: <FadersHorizontalIcon className="w-4 h-4" />, contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/tab-pages/general').then((module) => ({ default: module.GeneralPreferencesTab }))),
      },
      {
        id: 'format', labelKey: 'preferences.tabs.format',
        icon: <TextAUnderlineIcon className="w-4 h-4" />, contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/tab-pages/format').then((module) => ({ default: module.FormatPreferencesTab }))),
      },
      {
        id: 'shortcuts', labelKey: 'preferences.tabs.shortcuts',
        icon: <KeyboardIcon className="w-4 h-4" />, contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/sections/shortcuts').then((module) => ({ default: module.ShortcutsSection }))),
      },
      {
        id: 'cloudSync', labelKey: 'preferences.tabs.cloudSync',
        icon: <UserIcon className="w-4 h-4" />, contentWidth: 'normal',
        visibleInProductMenu: false,
        ...lazyPreferenceTab(() => import('@features/preferences/sections/cloud-sync').then((module) => ({ default: module.CloudSyncSection }))),
      },
      {
        id: 'productIntro', labelKey: 'preferences.tabs.productIntro',
        icon: <InfoIcon className="w-4 h-4" weight="regular" />, contentWidth: 'wide',
        ...lazyPreferenceTab(() => import('@features/preferences/sections/product-intro').then((module) => ({ default: module.ProductIntroSection }))),
      },
    ],
  },
  {
    labelKey: 'preferences.groups.notes',
    tabs: [
      {
        id: 'templates', labelKey: 'preferences.tabs.templates',
        icon: <SwatchesIcon className="w-4 h-4" />, contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/sections/templates').then((module) => ({ default: module.TemplatesSection }))),
      },
      {
        id: 'documentProperties', labelKey: 'preferences.tabs.documentProperties',
        icon: <ListChecksIcon className="w-4 h-4" />, contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/sections/document-properties').then((module) => ({ default: module.DocumentPropertiesSection }))),
      },
      {
        id: 'noteOther', labelKey: 'preferences.tabs.noteOther',
        icon: <DotsThreeCircleIcon className="w-4 h-4" />, contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/tab-pages/note-other').then((module) => ({ default: module.NoteOtherPreferencesTab }))),
      },
    ],
  },
  {
    labelKey: 'preferences.groups.ai',
    tabs: [
      {
        id: 'pi', labelKey: 'preferences.tabs.pi',
        icon: <AgentIcon typeKey="pi" alt="" className="w-4 h-4 object-contain" />, contentWidth: 'wide',
        ...lazyPreferenceTab(() => import('@features/preferences/sections/pi').then((module) => ({ default: module.PiSettingsSection }))),
      },
      {
        id: 'dsh', labelKey: 'preferences.tabs.dsh',
        icon: <AgentIcon typeKey="dsh" alt="" className="w-4 h-4 object-contain" />, contentWidth: 'wide',
        visibleInProductMenu: false,
        ...lazyPreferenceTab(() => import('@features/preferences/sections/dsh').then((module) => ({ default: module.DshSettingsSection }))),
      },
      {
        id: 'aiAgent', labelKey: 'preferences.tabs.aiAgent',
        icon: <StarFourIcon className="w-4 h-4" weight="regular" />, contentWidth: 'normal',
        visibleInProductMenu: false,
        ...lazyPreferenceTab(() => import('@features/preferences/sections/agents').then((module) => ({ default: module.AgentsSection }))),
      },
      {
        id: 'mcp', labelKey: 'preferences.tabs.mcp',
        icon: (
          <span
            aria-hidden="true"
            className="h-4 w-4 shrink-0 bg-current"
            style={{
              mask: `url("${mcpPluginIcon}") center / contain no-repeat`,
              WebkitMask: `url("${mcpPluginIcon}") center / contain no-repeat`,
            }}
          />
        ),
        contentWidth: 'normal',
        ...lazyPreferenceTab(() => import('@features/preferences/tab-pages/mcp').then((module) => ({ default: module.McpPreferencesTab }))),
      },
    ],
  },
] as const satisfies readonly PreferencesTabGroup[];

/** Visible only in the dedicated Preferences sidebar for development builds. */
export const DEVELOPMENT_PREFERENCE_TAB_GROUP = {
  labelKey: 'preferences.groups.development',
  tabs: [
    {
      id: 'environmentConfig',
      labelKey: 'preferences.tabs.environmentConfig',
      icon: <CloudIcon className="w-4 h-4" />,
      contentWidth: 'normal',
      visibleInProductMenu: false,
      ...lazyPreferenceTab(() => import('@features/preferences/tab-pages/environment-config').then((module) => ({ default: module.EnvironmentConfigPreferencesTab }))),
    },
  ],
} as const satisfies PreferencesTabGroup;

export type ActiveSettingsTab =
  | (typeof PREFERENCE_TAB_GROUPS)[number]['tabs'][number]['id']
  | (typeof DEVELOPMENT_PREFERENCE_TAB_GROUP.tabs)[number]['id'];

export const PREFERENCE_TABS = PREFERENCE_TAB_GROUPS.flatMap(
  (group) => [...group.tabs],
);

export const ALL_PREFERENCE_TABS = [
  ...PREFERENCE_TABS,
  ...DEVELOPMENT_PREFERENCE_TAB_GROUP.tabs,
];

export const PREFERENCE_TAB_BY_ID: ReadonlyMap<ActiveSettingsTab, PreferencesTabItem<ActiveSettingsTab>> = new Map(
  ALL_PREFERENCE_TABS.map((tab) => [tab.id, tab] as const),
);
