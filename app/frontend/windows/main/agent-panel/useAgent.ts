'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { agent, AgentConfig, AgentInfo, ChatResponse, listenToAgentStream, stopListeningToAgentStream } from '../../../lib/tauri/client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface UseAgentReturn {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  currentAgent: AgentInfo | null;
  streamingContent: string;
  initAgent: (config: AgentConfig) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  sendMessageStream: (message: string) => Promise<void>;
  clearMessages: () => void;
}

export function useAgent(): UseAgentReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentAgent, setCurrentAgent] = useState<AgentInfo | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  // Use ref to track streaming content for immediate access
  const streamingContentRef = useRef('');

  const initAgent = useCallback(async (config: AgentConfig) => {
    setIsLoading(true);
    setError(null);
    try {
      const info = await agent.init(config);
      setCurrentAgent(info);
      setThreadId(null);
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    if (!currentAgent) {
      setError('Agent not initialized');
      return;
    }

    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setIsLoading(true);
    setError(null);

    try {
      const activeThreadId = threadId || (await agent.createThread(currentAgent.id, message.slice(0, 28) || '新对话')).threadId;
      setThreadId(activeThreadId);
      const response: ChatResponse = await agent.chat(currentAgent.id, activeThreadId, {
        content: message,
        llmContent: message,
      });
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: response.response },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [currentAgent, threadId]);

  const sendMessageStream = useCallback(async (message: string) => {
    if (!currentAgent) {
      setError('Agent not initialized');
      return;
    }

    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setIsLoading(true);
    setError(null);
    setStreamingContent('');
    streamingContentRef.current = '';

    try {
      await listenToAgentStream((chunk) => {
        streamingContentRef.current += chunk;
        setStreamingContent(streamingContentRef.current);
      });

      const activeThreadId = threadId || (await agent.createThread(currentAgent.id, message.slice(0, 28) || '新对话')).threadId;
      setThreadId(activeThreadId);
      const response: ChatResponse = await agent.chatStream(currentAgent.id, activeThreadId, {
        content: message,
        llmContent: message,
      });

      const finalContent = streamingContentRef.current || response.response;
      if (finalContent) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: finalContent },
        ]);
      }
      setStreamingContent('');
      streamingContentRef.current = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      stopListeningToAgentStream();
      setIsLoading(false);
    }
  }, [currentAgent, threadId]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setThreadId(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListeningToAgentStream();
    };
  }, []);

  return {
    messages,
    isLoading,
    error,
    currentAgent,
    streamingContent,
    initAgent,
    sendMessage,
    sendMessageStream,
    clearMessages,
  };
}
