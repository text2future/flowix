/**
 * Type definitions for Flowix app
 * Simplified types for the Tauri-based project
 */

// ============================================
// Canva Types (DocTreeItem)
// ============================================

export interface DocTreeItem {
  id: string;
  name: string;
  type: "folder" | "document";
  parentId: string | null;
  children?: DocTreeItem[];
  fullPath?: string;
}

export interface SelectedItem {
  type: "file" | "folder";
  name: string;
  path: string;
}

export const SUPPORTED_TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".sh",
  ".bash",
  ".zsh",
  ".gitignore",
  ".env",
  ".conf",
  ".ini",
] as const;

export type SupportedTextExtension = (typeof SUPPORTED_TEXT_EXTENSIONS)[number];

export interface FileListItem {
  id: string;
  name: string;
  ext: string;
  path: string;
  type: "folder" | "document";
  createdAt: number;
  modifiedAt: number;
  size: number;
  title?: string;
  description?: string;
  originalPath?: string;
}

export interface FileListResponse {
  items: FileListItem[];
  total: number;
  hasMore: boolean;
}

// ============================================
// RPC Types (FlowixRPCSchema)
// ============================================

export interface FlowixRPCSchema {
  bun: {
    requests: {
      // Chat
      "chat:send": {
        params: {
          message: string;
          threadId: string;
          headers?: Record<string, string>;
        };
        response: { content: string; threadId: string };
      };

      // Files
      "files:getTree": {
        params: { spacePath: string };
        response: DocTreeItem[] | null;
      };
      "files:createFolder": {
        params: { spacePath: string; name: string; parentId?: string };
        response: DocTreeItem | null;
      };
      "files:createDoc": {
        params: { spacePath: string; name: string; parentId?: string };
        response: DocTreeItem | null;
      };
      "files:read": {
        params: { filePath: string };
        response: string | null;
      };
      "files:write": {
        params: { filePath: string; content: string };
        response: { success: boolean };
      };
      "files:delete": {
        params: { filePath: string };
        response: { success: boolean };
      };
      "files:rename": {
        params: { filePath: string; newName: string };
        response: { success: boolean; newPath: string };
      };
      "files:selectFiles": {
        params: Record<string, never>;
        response: { path: string; name: string; content: string }[] | null;
      };
      "files:importToNotebook": {
        params: {
          files: { name: string; content: string }[];
          spacePath?: string;
        };
        response: { success: boolean; imported: number };
      };

      // Thread
      "thread:list": {
        params: Record<string, never>;
        response: ThreadListItem[];
      };
      "thread:create": {
        params: { title?: string };
        response: { threadId: string };
      };
      "thread:get": {
        params: { threadId: string };
        response: { messages: ChatMessage[]; title: string } | null;
      };
      "thread:delete": {
        params: { threadId: string };
        response: { success: boolean };
      };

      // Settings
      "settings:get": {
        params: { key?: string };
        response: Record<string, unknown> | unknown;
      };
      "settings:set": {
        params: { key: string; value: unknown };
        response: { success: boolean };
      };

      // Window
      "window:setSize": {
        params: { width: number; height: number };
        response: { success: boolean };
      };
      "window:getSize": {
        params: Record<string, never>;
        response: { width: number; height: number };
      };

      // Links
      "links:openExternal": {
        params: { url: string };
        response: { success: boolean };
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {};
  };
}

// ============================================
// Agent Types (Simplified)
// ============================================

export interface ThreadListItem {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// Core message type used throughout the app
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "reasoning" | "end";
  content: string;
  llmContent?: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
  timestamp: string;
  isLoading?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolAgentType?: import("./agent").AgentTypeKey;
  toolData?: string;
  toolInput?: Record<string, unknown>;
  toolDisplay?: import("./agent").AgentToolDisplay;
  toolCalls?: ToolCall[];
  reasoning?: string;
  isCompleted?: boolean;
  isCollapsed?: boolean;
}

// Tool call definition
export interface ToolCall {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  args?: string;
}

// ============================================
// Frontend-only types
// ============================================

export interface ThreadInfo {
  id: string;
  title?: string;
  createdAt: string;
}

export interface FileChangeEvent {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  spacePath: string;
  timestamp: number;
}

// ============================================
// Memo Types
// ============================================

export interface MemoMeta {
  type: string;
  agent_name?: string;
  agent_description?: string;
}
