'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { AgentConfig } from '../../../lib/tauri/client';

interface AgentConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: AgentConfig) => void;
}

export function AgentConfigModal({ open, onOpenChange, onSave }: AgentConfigModalProps) {
  const [name, setName] = useState('My Agent');
  const [apiUrl, setApiUrl] = useState('https://api.minimaxi.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('MiniMax-M3');
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful assistant.');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name,
      api_url: apiUrl,
      api_key: apiKey,
      model,
      system_prompt: systemPrompt,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Configure Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Agent Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Agent"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">API URL</label>
            <Input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Model</label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">System Prompt</label>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={4}
            />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}