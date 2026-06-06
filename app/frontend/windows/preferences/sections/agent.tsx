'use client';

import { useState, useEffect } from 'react';
import { useChatStore } from '../../../lib/store/chat-store';
import type { AgentConfig } from '../../../lib/tauri/client';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Field, SectionHeader, FIELD_INPUT_CLASS } from './primitives';

export function AgentSection() {
  const { savedAgentConfig, initAgent } = useChatStore();
  const [isSaving, setIsSaving] = useState(false);
  const [localConfig, setLocalConfig] = useState<AgentConfig | null>(null);

  // Sync local config when store loads
  useEffect(() => {
    if (savedAgentConfig) {
      setLocalConfig({ ...savedAgentConfig });
    } else {
      setLocalConfig({
        name: 'My Agent',
        api_url: 'https://api.minimaxi.com/v1',
        api_key: '',
        model: 'MiniMax-M3',
        system_prompt: '',
      });
    }
  }, [savedAgentConfig]);

  const handleSave = async () => {
    if (!localConfig) return;
    setIsSaving(true);
    try {
      await initAgent(localConfig);
    } finally {
      setIsSaving(false);
    }
  };

  if (!localConfig) {
    return <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Agent Configuration"
        description="Configure your AI agent settings for chat functionality"
      />

      <div className="space-y-4">
        <Field
          title="Model"
          description="The language model powering the agent"
          hint="Supported: GPT-4o, GPT-4o-mini, Claude 3.5 Sonnet, etc."
        >
          <Input
            value={localConfig.model}
            onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
            placeholder="e.g., gpt-4o-mini, claude-3-sonnet"
            className={FIELD_INPUT_CLASS}
          />
        </Field>

        <Field title="API URL" description="Endpoint of the model provider">
          <Input
            value={localConfig.api_url}
            onChange={(e) => setLocalConfig({ ...localConfig, api_url: e.target.value })}
            placeholder="https://api.openai.com/v1"
            className={FIELD_INPUT_CLASS}
          />
        </Field>

        <Field title="API Key" description="Stored locally, never sent to a third party">
          <Input
            type="password"
            value={localConfig.api_key}
            onChange={(e) => setLocalConfig({ ...localConfig, api_key: e.target.value })}
            placeholder="sk-..."
            className={FIELD_INPUT_CLASS}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving} size="sm">
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
