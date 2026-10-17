export type SandboxMode = "read-only" | "workspace-write";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  attachments?: ContextAttachment[];
}

export interface Conversation {
  id: string;
  title: string;
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messages: ChatMessage[];
  draftText: string;
  draftAttachments: ContextAttachment[];
  model: string;
}

export interface PluginSettings {
  codexPath: string;
  sandboxMode: SandboxMode;
  approveForMe: boolean;
  schemaVersion: 1;
  activeConversationId: string;
  conversations: Conversation[];
}

export interface CodexExecutionSettings {
  codexPath: string;
  sandboxMode: SandboxMode;
  approveForMe: boolean;
  sessionId: string | null;
  model: string;
}

export interface CodexRunCallbacks {
  onThreadId: (threadId: string) => void;
  onStatus: (status: string) => void;
  onProgress: (event: CodexProgressEvent) => void;
}
import type { CodexProgressEvent } from "./codex-events";
import type { ContextAttachment } from "./context";
