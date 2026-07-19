'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@features/i18n';
import { agent, type AgentExternalEntry } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import {
  FIELD_TITLE_CLASS,
  FIELD_INPUT_CLASS,
} from '@features/preferences/sections/primitives';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

interface ExternalPathRowProps {
  agentType: string;
  displayName: string;
  entry: AgentExternalEntry | undefined;
  onChanged: () => void;
  /// 未安装时 (path 为空) 显示的"安装/下载"入口; 不传则不显示该按钮。
  onInstall?: () => void;
}

/// 偏好设置里单个 external agent 的"状态 + 执行路径"合并区块, 样式对齐
/// AI 模型配置 (AgentSection): `FIELD_TITLE_CLASS` 标题 + `Input`(`FIELD_INPUT_CLASS`)
/// + `Button` + `Loader2` loading。布局:
///
///   {状态文案}
///   [Input: /path]   [安装?] [切换] [检查]
///
/// 状态随可用性变化 (已安装/未安装/路径不可用/未检测); 路径 disabled 只读;
/// "切换"打开文件浏览器 (tooltip 提示 ⌘⇧.); "检查"重新探测。
export function ExternalPathRow({
  agentType,
  displayName,
  entry,
  onChanged,
  onInstall,
}: ExternalPathRowProps) {
  const { t } = useI18n();
  const [switching, setSwitching] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const currentPath = entry?.path ?? '';
  const hasEntry = !!entry;
  const available = entry?.available ?? false;
  const pathInvalid = hasEntry && currentPath !== '' && !available;
  const notInstalled = hasEntry && currentPath === '';
  const showInstall = notInstalled && !!onInstall;

  const statusText = !hasEntry
    ? t('preferences.agents.external.statusNotChecked', { name: displayName })
    : pathInvalid
      ? t('preferences.agents.external.statusPathInvalid', { name: displayName })
      : available
        ? t('preferences.agents.external.statusInstalled', { name: displayName })
        : t('preferences.agents.external.statusNotInstalled', { name: displayName });

  const switchPath = async () => {
    setSwitching(true);
    try {
      const selected = await agent.selectExternalCliPath();
      const trimmed = selected?.trim();
      if (!trimmed) return;
      await agent.setExternalPath(agentType, trimmed);
      onChanged();
      toast.info(t('preferences.agents.external.pathSaved'));
    } catch {
      toast.error(t('preferences.agents.external.pathNotExecutable'));
    } finally {
      setSwitching(false);
    }
  };

  const check = async () => {
    setDetecting(true);
    try {
      const result = await agent.redetectExternal(agentType);
      onChanged();
      if (result.available) {
        toast.success(t('preferences.agents.external.checkSuccess'));
      } else if (result.path) {
        toast.error(t('preferences.agents.external.checkUnavailable'));
      } else {
        toast.error(t('preferences.agents.external.checkNotFound'));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('preferences.agents.external.checkFailed', { message }));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="space-y-1.5 border-t border-[var(--divider)] py-4">
      <label className={cn(FIELD_TITLE_CLASS, pathInvalid && 'text-[var(--destructive)]')}>
        {statusText}
      </label>
      <div className="flex items-center gap-2">
        <Input
          value={currentPath}
          placeholder={t('preferences.agents.external.notConfigured')}
          spellCheck={false}
          disabled
          readOnly
          className={cn(
            'min-w-0 flex-1',
            FIELD_INPUT_CLASS,
            pathInvalid &&
              'border-[var(--destructive)] text-[var(--destructive)] placeholder:text-[var(--destructive)]',
          )}
        />
        <div className="flex shrink-0 items-center gap-2">
          {showInstall && (
            <Button type="button" onClick={onInstall}>
              {t('preferences.agents.external.install')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            title={t('preferences.agents.external.selectHint')}
            disabled={switching}
            onClick={() => void switchPath()}
          >
            {switching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t('preferences.agents.external.select')
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={detecting}
            onClick={() => void check()}
          >
            {detecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t('preferences.agents.external.check')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
