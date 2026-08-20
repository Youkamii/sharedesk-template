"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { LOCALE_BCP47, translate, type Locale } from "@/lib/i18n";
import styles from "./desktop.module.css";

const CHAT_MAX_TEXT_LENGTH = 2_000;
const ACTIVE_POLL_MS = 4_000;
const IDLE_POLL_MS = 20_000;
const MINIMIZED_POLL_MS = 60_000;
const ACTIVE_WINDOW_MS = 30_000;

type ClientChatMessage = {
  id: string;
  name: string;
  text: string;
  createdAt: string;
  mine: boolean;
};

type Props = {
  locale: Locale;
  minimized: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onUnreadChange: (count: number) => void;
};

function isMessage(value: unknown): value is ClientChatMessage {
  const message = value as Partial<ClientChatMessage> | null;
  return (
    !!message &&
    typeof message.id === "string" &&
    typeof message.name === "string" &&
    typeof message.text === "string" &&
    typeof message.createdAt === "string" &&
    typeof message.mine === "boolean"
  );
}

export default function ChatPanel({
  locale,
  minimized,
  onClose,
  onMinimize,
  onUnreadChange,
}: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<ClientChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef("");
  const firstLoadRef = useRef(true);
  const unreadRef = useRef(0);
  const burstUntilRef = useRef(0);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  useEffect(() => {
    if (!minimized) {
      unreadRef.current = 0;
      onUnreadChange(0);
      burstUntilRef.current = Date.now() + ACTIVE_WINDOW_MS;
    }
  }, [minimized, onUnreadChange]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (cancelled) return;
      const delay = minimized
        ? MINIMIZED_POLL_MS
        : Date.now() < burstUntilRef.current
          ? ACTIVE_POLL_MS
          : IDLE_POLL_MS;
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (cancelled) return;
      if (document.hidden) {
        schedule();
        return;
      }
      controller?.abort();
      controller = new AbortController();
      try {
        const query = lastIdRef.current
          ? `?after=${encodeURIComponent(lastIdRef.current)}`
          : "";
        const response = await fetch(`/api/chat${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          router.replace("/");
          return;
        }
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? t("채팅을 불러오지 못했습니다"));
        }
        const incoming: ClientChatMessage[] = Array.isArray(body?.messages)
          ? body.messages.filter(isMessage)
          : [];
        if (incoming.length > 0) {
          setMessages((current) => {
            const byId = new Map(current.map((message) => [message.id, message]));
            for (const message of incoming) byId.set(message.id, message);
            const merged = [...byId.values()]
              .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
              .slice(-200);
            lastIdRef.current = merged.at(-1)?.id ?? "";
            return merged;
          });
          if (!firstLoadRef.current && minimized) {
            unreadRef.current += incoming.filter((message) => !message.mine).length;
            onUnreadChange(unreadRef.current);
          }
          burstUntilRef.current = Date.now() + ACTIVE_WINDOW_MS;
        }
        firstLoadRef.current = false;
        setError(null);
      } catch (caught) {
        if (!cancelled && (caught as Error)?.name !== "AbortError") {
          setError(
            caught instanceof Error
              ? caught.message
              : t("채팅을 불러오지 못했습니다"),
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          schedule();
        }
      }
    };

    const onVisibility = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [minimized, onUnreadChange, router, t]);

  useEffect(() => {
    if (!minimized) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, minimized]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending || text.length > CHAT_MAX_TEXT_LENGTH) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (response.status === 401) {
        router.replace("/");
        return;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? t("메시지를 보내지 못했습니다"));
      if (!isMessage(body?.message)) throw new Error(t("메시지를 확인하지 못했습니다"));
      setMessages((current) => [...current.filter((item) => item.id !== body.message.id), body.message].slice(-200));
      lastIdRef.current = body.message.id;
      burstUntilRef.current = Date.now() + ACTIVE_WINDOW_MS;
      setDraft("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("메시지를 보내지 못했습니다"),
      );
    } finally {
      setSending(false);
    }
  }

  function formatTime(value: string) {
    return new Date(value).toLocaleTimeString(LOCALE_BCP47[locale], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <section
      className={`${styles.folderWindow} ${styles.chatWindow} ${minimized ? styles.utilityHidden : ""}`}
      aria-label={t("데스크 채팅")}
    >
      <header className={styles.windowTitlebar}>
        <strong>{t("데스크 채팅")}</strong>
        <span className={styles.windowControls}>
          <button type="button" aria-label={t("최소화")} onClick={onMinimize}>
            <span className={styles.minimizeGlyph} />
          </button>
          <button type="button" aria-label={t("닫기")} onClick={onClose}>
            <span className={styles.closeGlyph} />
          </button>
        </span>
      </header>
      <div ref={listRef} className={styles.chatMessages} aria-live="polite">
        {loading && messages.length === 0 ? (
          <p>{t("채팅을 불러오는 중입니다…")}</p>
        ) : messages.length === 0 ? (
          <p>{t("첫 메시지를 남겨 보세요.")}</p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={message.mine ? styles.chatMine : undefined}
            >
              <header>
                <strong>{message.name}</strong>
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              </header>
              <p>{message.text}</p>
            </article>
          ))
        )}
      </div>
      {error && <p className={styles.chatError} role="alert">{error}</p>}
      <form className={styles.chatComposer} onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          maxLength={CHAT_MAX_TEXT_LENGTH}
          rows={2}
          aria-label={t("메시지")}
          placeholder={t("메시지 입력")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          {sending ? t("보내는 중…") : t("보내기")}
        </button>
      </form>
    </section>
  );
}
