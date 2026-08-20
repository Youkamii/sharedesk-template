import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

const FILE = "chat.json";
const FILE_VERSION = 1;
const MAX_MESSAGES = 500;
const MAX_RETURNED_MESSAGES = 100;
const MAX_CAS_ATTEMPTS = 8;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const CHAT_MAX_TEXT_LENGTH = 2_000;

export interface ChatMessage {
  id: string;
  userId: string;
  name: string;
  text: string;
  createdAt: string;
}

interface ChatFile {
  version: 1;
  messages: ChatMessage[];
}

function normalize(raw: unknown): ChatFile {
  const candidate = raw as Partial<ChatFile> | null;
  if (!candidate || !Array.isArray(candidate.messages)) {
    return { version: FILE_VERSION, messages: [] };
  }
  const messages = candidate.messages
    .filter((value): value is ChatMessage => {
      const message = value as Partial<ChatMessage> | null;
      return (
        !!message &&
        typeof message.id === "string" &&
        typeof message.userId === "string" &&
        typeof message.name === "string" &&
        typeof message.text === "string" &&
        typeof message.createdAt === "string" &&
        Number.isFinite(Date.parse(message.createdAt))
      );
    })
    .slice(-MAX_MESSAGES);
  return { version: FILE_VERSION, messages };
}

function retained(messages: ChatMessage[], now = Date.now()): ChatMessage[] {
  const cutoff = now - RETENTION_MS;
  return messages.filter(
    (message) => {
      const createdAt = Date.parse(message.createdAt);
      return createdAt >= cutoff && createdAt <= now + 5 * 60 * 1000;
    },
  );
}

export function normalizeChatText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replaceAll("\r\n", "\n").trim();
  return text && text.length <= CHAT_MAX_TEXT_LENGTH ? text : null;
}

export async function listChatMessages(afterId?: string): Promise<ChatMessage[]> {
  const file = normalize(await getAdapter().readState<ChatFile>(FILE));
  const messages = retained(file.messages);
  if (!afterId) return messages.slice(-MAX_RETURNED_MESSAGES);
  const index = messages.findIndex((message) => message.id === afterId);
  return index >= 0
    ? messages.slice(index + 1, index + 1 + MAX_RETURNED_MESSAGES)
    : messages.slice(-MAX_RETURNED_MESSAGES);
}

export async function sendChatMessage(input: {
  userId: string;
  name: string;
  text: unknown;
}): Promise<ChatMessage> {
  const text = normalizeChatText(input.text);
  if (!text) {
    throw new StorageError(
      "BAD_ID",
      `메시지는 1자 이상 ${CHAT_MAX_TEXT_LENGTH}자 이하로 입력해 주세요`,
    );
  }
  const message: ChatMessage = {
    id: randomUUID(),
    userId: input.userId,
    name: input.name.trim().slice(0, 160) || "이름 없음",
    text,
    createdAt: new Date().toISOString(),
  };
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ChatFile>(FILE);
    const file = normalize(state.value);
    const next: ChatFile = {
      version: FILE_VERSION,
      messages: [...retained(file.messages), message].slice(-MAX_MESSAGES),
    };
    try {
      await adapter.compareAndSwapState(FILE, next, state.version);
      return message;
    } catch (error) {
      lastError = error;
      if (!(error instanceof StorageError) || error.code !== "CONFLICT") {
        throw error;
      }
    }
  }
  throw lastError ?? new StorageError("CONFLICT", "메시지를 다시 보내 주세요");
}
