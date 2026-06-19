import type { ComponentType } from "react";
import {
  Folder,
  FileText,
  Edit,
  Trash2,
  Search,
  Code,
  Terminal,
  GitBranch,
  Database,
  Server,
  Settings,
  Play,
  Pause,
  RefreshCw,
  Eye,
} from "lucide-react";

// File operations
export const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  // File operations
  ls: Folder,
  read: FileText,
  write: Edit,
  edit: Edit,
  list_directory: Folder,
  read_file: FileText,
  write_file: Edit,
  edit_file: Edit,
  create_file: Edit,
  delete_file: Trash2,
  search_files: Search,
  glob: Search,
  grep: Search,
  // Code operations
  code: Code,
  execute_command: Terminal,
  bash: Terminal,
  shell: Terminal,
  // Git operations
  git_branch: GitBranch,
  git_commit: GitBranch,
  git_status: GitBranch,
  // Database
  db_query: Database,
  database: Database,
  // Services
  server: Server,
  api: Server,
  // Other
  settings: Settings,
  run: Play,
  stop: Pause,
  restart: RefreshCw,
  view: Eye,
};

export function getToolIcon(toolName: string | undefined): ComponentType<{ className?: string }> {
  if (!toolName) return Terminal;
  return TOOL_ICONS[toolName] || Terminal;
}
