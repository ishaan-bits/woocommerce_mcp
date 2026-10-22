/**
 * Module-level chat store so the conversation survives route changes (a
 * remount of ChatPage must not wipe history). Pure data container — no DOM,
 * no fetch. The in-flight request + AbortController stay component-local.
 */

import type { ChatMessage } from "./chat.ts";

type Listener = () => void;

export interface ChatErrorState {
  code: string;
  message: string;
  /** Provider-requested wait before a retry (seconds), when the server knew. */
  retryAfterSeconds?: number;
}

let messages: ChatMessage[] = [];
let lastError: ChatErrorState | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getChatMessages(): readonly ChatMessage[] {
  return messages;
}

export function getChatError(): ChatErrorState | null {
  return lastError;
}

export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function appendChatMessage(message: ChatMessage): void {
  messages = [...messages, message];
  emit();
}

export function setChatMessages(next: ChatMessage[]): void {
  messages = next;
  emit();
}

export function setChatError(error: ChatErrorState | null): void {
  lastError = error;
  emit();
}

/** Test-only reset; the UI never calls this. */
export function resetChatStore(): void {
  messages = [];
  lastError = null;
}
