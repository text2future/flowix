'use client';

import { useState } from 'react';
import { useAgent } from './useAgent';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';

interface AgentChatProps {
  onConfigRequest: () => void;
}

export function AgentChat({ onConfigRequest }: AgentChatProps) {
  const { messages, isLoading, error, currentAgent, sendMessageStream, streamingContent } =
    useAgent();
  const [input, setInput] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const message = input.trim();
    setInput('');
    await sendMessageStream(message);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">Agent Chat</h3>
          {currentAgent && (
            <span className="text-xs text-muted-foreground">({currentAgent.name})</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onConfigRequest}>
          {currentAgent ? 'Change Agent' : 'Setup Agent'}
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!currentAgent ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <p className="mb-2">No agent configured</p>
            <Button variant="outline" onClick={onConfigRequest}>
              Setup Agent
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <p>Start a conversation with {currentAgent.name}</p>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
        {isLoading && streamingContent && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-2">
              <span className="animate-pulse">Thinking... {streamingContent}</span>
            </div>
          </div>
        )}
        {isLoading && !streamingContent && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-2">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}
        {error && (
          <div className="text-destructive text-sm p-2 bg-destructive/10 rounded">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      {currentAgent && (
        <form onSubmit={handleSubmit} className="border-t p-4 flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={isLoading}
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}