import type { ChatMessage, Conversation, PluginSettings, SandboxMode } from "./types";
import { parseAttachments } from "./context.ts";
import { parseImages } from "./image-attachments.ts";

export const CONVERSATION_SCHEMA_VERSION = 1;
export const MAX_CONVERSATIONS = 100;
export const MAX_MESSAGES_PER_CONVERSATION = 500;

const DEFAULT_TITLE = "新对话";

interface LoadOptions {
  now?: () => number;
  makeId?: () => string;
}

export interface LoadResult {
  settings: PluginSettings;
  recoveredRecords: number;
  migratedLegacy: boolean;
}

export function loadPluginSettings(raw: unknown, options: LoadOptions = {}): LoadResult {
  const now = options.now ?? Date.now;
  const makeId = options.makeId ?? createId;
  const source = isRecord(raw) ? raw : {};
  const base = {
    cleanLivePreview: typeof source.cleanLivePreview === "boolean" ? source.cleanLivePreview : true,
    autoFormatCode: typeof source.autoFormatCode === "boolean" ? source.autoFormatCode : true,
    gofmtPath: asString(source.gofmtPath) ?? "",
    blackPath: asString(source.blackPath) ?? "",
    codexPath: asString(source.codexPath) ?? "codex",
    sandboxMode: asSandboxMode(source.sandboxMode) ?? "workspace-write",
    approveForMe: typeof source.approveForMe === "boolean" ? source.approveForMe : true
  };

  if (typeof source.schemaVersion === "number" && source.schemaVersion >= CONVERSATION_SCHEMA_VERSION
    && Array.isArray(source.conversations)) {
    const parsed = source.conversations
      .map(parseConversation)
      .filter((conversation): conversation is Conversation => conversation !== null)
      .slice(0, MAX_CONVERSATIONS);
    const recoveredRecords = source.conversations.length - parsed.length;
    const conversations = parsed.length > 0 ? parsed : [createConversation(now(), makeId())];
    if (!conversations.some(({ archived }) => !archived)) {
      if (conversations.length < MAX_CONVERSATIONS) {
        conversations.push(createConversation(now(), makeId()));
      } else {
        conversations[0].archived = false;
      }
    }
    const requestedActive = asString(source.activeConversationId);
    const activeConversationId = conversations.some(({ id, archived }) => id === requestedActive && !archived)
      ? requestedActive as string
      : conversations.find(({ archived }) => !archived)?.id ?? conversations[0].id;
    return {
      settings: { ...base, schemaVersion: 1, activeConversationId, conversations },
      recoveredRecords,
      migratedLegacy: false
    };
  }

  const timestamp = now();
  const legacyMessages = Array.isArray(source.messages)
    ? source.messages.map(parseMessage).filter((message): message is ChatMessage => message !== null)
    : [];
  const conversation = createConversation(timestamp, makeId(), {
    threadId: asNullableString(source.sessionId),
    messages: legacyMessages.slice(-MAX_MESSAGES_PER_CONVERSATION),
    title: titleFromMessages(legacyMessages)
  });
  return {
    settings: {
      ...base,
      schemaVersion: 1,
      activeConversationId: conversation.id,
      conversations: [conversation]
    },
    recoveredRecords: Array.isArray(source.messages) ? source.messages.length - legacyMessages.length : 0,
    migratedLegacy: "sessionId" in source || "messages" in source
  };
}

export class ConversationRepository {
  readonly settings: PluginSettings;
  private readonly now: () => number;
  private readonly makeId: () => string;

  constructor(
    settings: PluginSettings,
    now: () => number = Date.now,
    makeId: () => string = createId
  ) {
    this.settings = settings;
    this.now = now;
    this.makeId = makeId;
  }

  get active(): Conversation {
    const selected = this.settings.conversations.find(({ id }) => id === this.settings.activeConversationId);
    if (selected && !selected.archived) return selected;
    const fallback = this.settings.conversations.find(({ archived }) => !archived)
      ?? this.settings.conversations[0]
      ?? createConversation(this.now(), this.makeId());
    fallback.archived = false;
    if (this.settings.conversations.length === 0) this.settings.conversations.push(fallback);
    this.settings.activeConversationId = fallback.id;
    return fallback;
  }

  create(title = DEFAULT_TITLE): Conversation {
    if (this.settings.conversations.length >= MAX_CONVERSATIONS) {
      throw new Error(`对话数量已达上限（${MAX_CONVERSATIONS}）。请先归档或删除旧对话。`);
    }
    const conversation = createConversation(this.now(), this.makeId(), { title: cleanTitle(title) });
    this.settings.conversations.push(conversation);
    this.settings.activeConversationId = conversation.id;
    return conversation;
  }

  select(id: string): Conversation {
    const conversation = this.require(id);
    this.settings.activeConversationId = conversation.id;
    return conversation;
  }

  rename(id: string, title: string): Conversation {
    const conversation = this.require(id);
    conversation.title = cleanTitle(title);
    conversation.updatedAt = this.now();
    return conversation;
  }

  setArchived(id: string, archived: boolean): Conversation {
    const conversation = this.require(id);
    conversation.archived = archived;
    conversation.updatedAt = this.now();
    if (archived && conversation.id === this.settings.activeConversationId) {
      const replacement = this.settings.conversations.find((item) => !item.archived && item.id !== id)
        ?? (this.settings.conversations.length < MAX_CONVERSATIONS
          ? this.create()
          : this.settings.conversations.find((item) => item.id !== id));
      if (!replacement) {
        conversation.archived = false;
        throw new Error("至少需要保留一个未归档的对话。");
      }
      replacement.archived = false;
      this.settings.activeConversationId = replacement.id;
    }
    return conversation;
  }

  delete(id: string): void {
    const index = this.settings.conversations.findIndex((conversation) => conversation.id === id);
    if (index < 0) throw new Error("找不到指定的对话。");
    this.settings.conversations.splice(index, 1);
    if (this.settings.conversations.length === 0) this.create();
    if (this.settings.activeConversationId === id) {
      this.settings.activeConversationId = this.settings.conversations.find(({ archived }) => !archived)?.id
        ?? this.settings.conversations[0].id;
    }
  }

  appendMessage(message: ChatMessage): Conversation {
    const conversation = this.active;
    conversation.messages.push(message);
    if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION);
    }
    if (conversation.title === DEFAULT_TITLE && message.role === "user") {
      conversation.title = cleanTitle(message.text.slice(0, 48));
    }
    conversation.updatedAt = this.now();
    return conversation;
  }

  setThreadId(threadId: string | null): Conversation {
    const conversation = this.active;
    conversation.threadId = threadId;
    conversation.updatedAt = this.now();
    return conversation;
  }

  private require(id: string): Conversation {
    const conversation = this.settings.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("找不到指定的对话。");
    return conversation;
  }
}

function createConversation(
  timestamp: number,
  id: string,
  values: Partial<Pick<Conversation, "title" | "threadId" | "messages">> = {}
): Conversation {
  return {
    id,
    title: values.title ?? DEFAULT_TITLE,
    threadId: values.threadId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    messages: values.messages ?? [],
    draftText: "", draftAttachments: [], draftImages: [], model: ""
  };
}

function parseConversation(value: unknown): Conversation | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const title = asString(value.title);
  const createdAt = asTimestamp(value.createdAt);
  const updatedAt = asTimestamp(value.updatedAt);
  if (!id || !title || createdAt === null || updatedAt === null || typeof value.archived !== "boolean") return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(parseMessage).filter((message): message is ChatMessage => message !== null)
    : [];
  return {
    id,
    title,
    threadId: asNullableString(value.threadId),
    createdAt,
    updatedAt,
    archived: value.archived,
    messages: messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
    draftText: typeof value.draftText === "string" ? value.draftText : "",
    draftAttachments: parseAttachments(value.draftAttachments),
    draftImages: parseImages(value.draftImages),
    model: typeof value.model === "string" ? value.model : ""
  };
}

function parseMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const text = typeof value.text === "string" ? value.text : null;
  const createdAt = asTimestamp(value.createdAt);
  const role = value.role;
  if (!id || text === null || createdAt === null || (role !== "user" && role !== "assistant" && role !== "system")) {
    return null;
  }
  return { id, role, text, createdAt, ...(Array.isArray(value.attachments) ? { attachments: parseAttachments(value.attachments) } : {}),
    ...(Array.isArray(value.images) ? { images: parseImages(value.images) } : {}) };
}

function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find(({ role, text }) => role === "user" && text.trim());
  return firstUser ? cleanTitle(firstUser.text.slice(0, 48)) : DEFAULT_TITLE;
}

function cleanTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").slice(0, 80) || DEFAULT_TITLE;
}

function asSandboxMode(value: unknown): SandboxMode | null {
  return value === "read-only" || value === "workspace-write" ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
