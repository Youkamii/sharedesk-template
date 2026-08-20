"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import { uploadWithProgress } from "@/lib/client/transfer";
import type { ShareLink } from "@/lib/share-links";
import styles from "./desktop.module.css";

type UploadSession =
  | { mode: "direct"; url: string; reservationId?: string }
  | { mode: "proxy"; reservationId?: string };

type QuickItem = {
  id: string;
  file: File;
  progress: number;
  status: "uploading" | "ready" | "failed" | "stopped";
  link: ShareLink | null;
  error: string | null;
  keeping: boolean;
};

type Props = {
  locale: Locale;
  maximized: boolean;
  zIndex: number;
  active: boolean;
  canManageLinks: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onOpenLinks: () => void;
  onDesktopChanged: () => void;
  onNotice: (message: string) => void;
  onActivate: () => void;
};

function shareUrl(linkId: string): string {
  return `${window.location.origin}/api/share/${linkId}`;
}

function isShareLink(value: unknown): value is ShareLink {
  const link = value as Partial<ShareLink> | null;
  return (
    !!link &&
    typeof link.linkId === "string" &&
    typeof link.fileId === "string" &&
    typeof link.name === "string" &&
    typeof link.expiresAt === "string"
  );
}

export default function QuickLinkWindow({
  locale,
  maximized,
  zIndex,
  active,
  canManageLinks,
  onClose,
  onMinimize,
  onToggleMaximize,
  onOpenLinks,
  onDesktopChanged,
  onNotice,
  onActivate,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<QuickItem[]>([]);
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);

  function patchItem(id: string, patch: Partial<QuickItem>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    if (response.status === 401) {
      router.replace("/");
      throw new Error(t("세션이 만료되었습니다"));
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ?? t("요청에 실패했습니다"));
    }
    return body as T;
  }

  async function uploadOne(item: QuickItem) {
    const file = item.file;
    const mimeType = file.type || "application/octet-stream";
    try {
      const session = await apiJson<UploadSession>(
        "/api/drive/quick-link/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            mimeType,
            size: file.size,
          }),
        },
      );
      let linkValue: unknown;
      if (session.mode === "direct") {
        const upload = await uploadWithProgress(
          session.url,
          "PUT",
          file,
          null,
          (sent, total) => patchItem(item.id, { progress: total ? sent / total : 0 }),
        );
        if (upload.status < 200 || upload.status >= 300) {
          throw new Error(t("드라이브 업로드에 실패했습니다"));
        }
        const uploaded = JSON.parse(upload.responseText || "null") as {
          id?: string;
        } | null;
        if (!uploaded?.id) throw new Error(t("업로드 결과를 확인하지 못했습니다"));
        const finalized = await apiJson<{ link?: unknown }>(
          "/api/drive/quick-link",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fileId: uploaded.id,
              name: file.name,
              reservationId: session.reservationId,
            }),
          },
        );
        linkValue = finalized.link;
      } else {
        const reservation = session.reservationId
          ? `&reservationId=${encodeURIComponent(session.reservationId)}`
          : "";
        const upload = await uploadWithProgress(
          `/api/drive/quick-link/upload?name=${encodeURIComponent(file.name)}${reservation}`,
          "POST",
          file,
          mimeType,
          (sent, total) => patchItem(item.id, { progress: total ? sent / total : 0 }),
        );
        const body = JSON.parse(upload.responseText || "null") as {
          link?: unknown;
          error?: string;
        } | null;
        if (upload.status < 200 || upload.status >= 300) {
          throw new Error(body?.error ?? t("업로드에 실패했습니다"));
        }
        linkValue = body?.link;
      }
      if (!isShareLink(linkValue)) {
        throw new Error(t("공유 링크를 확인하지 못했습니다"));
      }
      patchItem(item.id, {
        status: "ready",
        progress: 1,
        link: linkValue,
        error: null,
      });
      await navigator.clipboard.writeText(shareUrl(linkValue.linkId)).catch(() => undefined);
    } catch (error) {
      patchItem(item.id, {
        status: "failed",
        error: error instanceof Error ? error.message : t("업로드에 실패했습니다"),
      });
    }
  }

  async function addFiles(files: FileList | File[]) {
    const next = Array.from(files).map<QuickItem>((file) => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      status: "uploading",
      link: null,
      error: null,
      keeping: false,
    }));
    if (!next.length) return;
    setItems((current) => [...next, ...current]);
    for (const item of next) await uploadOne(item);
  }

  async function copy(link: ShareLink) {
    try {
      await navigator.clipboard.writeText(shareUrl(link.linkId));
      onNotice(t("공유 링크를 복사했습니다."));
    } catch {
      onNotice(shareUrl(link.linkId));
    }
  }

  async function keep(item: QuickItem) {
    if (!item.link || item.keeping || !item.link.deleteOnExpire) return;
    patchItem(item.id, { keeping: true, error: null });
    try {
      const body = await apiJson<{ link?: unknown }>("/api/drive/quick-link", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: item.link.linkId }),
      });
      if (!isShareLink(body.link)) throw new Error(t("파일을 옮기지 못했습니다"));
      patchItem(item.id, { link: body.link, keeping: false });
      onDesktopChanged();
      onNotice(t("파일을 데스크 바탕화면에 남겼습니다."));
    } catch (error) {
      patchItem(item.id, {
        keeping: false,
        error: error instanceof Error ? error.message : t("파일을 옮기지 못했습니다"),
      });
    }
  }

  async function stop(item: QuickItem) {
    if (!item.link) return;
    try {
      await apiJson("/api/drive/quick-link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: item.link.linkId }),
      });
      patchItem(item.id, { status: "stopped" });
      onNotice(t("공유 링크를 멈췄습니다."));
    } catch (error) {
      patchItem(item.id, {
        error: error instanceof Error ? error.message : t("공유를 멈추지 못했습니다"),
      });
    }
  }

  return (
    <section
      className={`${styles.folderWindow} ${styles.quickLinkWindow} ${active ? styles.activeWindow : ""} ${maximized ? styles.utilityMaximized : ""}`}
      style={{ zIndex }}
      aria-label={t("간이 링크")}
      onPointerDown={onActivate}
    >
      <header className={styles.windowTitlebar}>
        <strong>{t("간이 링크")}</strong>
        <span className={styles.windowControls}>
          <button type="button" aria-label={t("최소화")} onClick={onMinimize}>
            <span className={styles.minimizeGlyph} />
          </button>
          <button
            type="button"
            aria-label={maximized ? t("복원") : t("최대화")}
            onClick={onToggleMaximize}
          >
            <span className={styles.maximizeGlyph} />
          </button>
          <button type="button" aria-label={t("닫기")} onClick={onClose}>
            <span className={styles.closeGlyph} />
          </button>
        </span>
      </header>
      <div
        className={styles.quickDropzone}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }}
      >
        <strong>{t("파일을 놓으면 바로 1시간 링크를 만듭니다")}</strong>
        <span>{t("체크된 파일은 1시간 뒤 실제 파일도 자동으로 삭제됩니다.")}</span>
        <button type="button" onClick={() => inputRef.current?.click()}>
          {t("파일 고르기")}
        </button>
        {canManageLinks && (
          <button type="button" onClick={onOpenLinks}>
            {t("공유 중인 링크 보기")}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          className={styles.hiddenInput}
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <div className={styles.quickLinkList}>
        {items.length === 0 ? (
          <p>{t("아직 만든 간이 링크가 없습니다.")}</p>
        ) : (
          items.map((item) => (
            <article key={item.id} className={styles.quickLinkRow}>
              <label>
                <input
                  type="checkbox"
                  checked={item.link?.deleteOnExpire === true}
                  disabled={
                    item.status !== "ready" ||
                    item.keeping ||
                    item.link?.deleteOnExpire !== true
                  }
                  onChange={(event) => {
                    if (!event.target.checked) void keep(item);
                  }}
                />
                <span>{item.file.name}</span>
              </label>
              {item.status === "uploading" && (
                <progress max={1} value={item.progress} />
              )}
              {item.status === "ready" && item.link && (
                <div className={styles.quickLinkActions}>
                  <input readOnly value={shareUrl(item.link.linkId)} onFocus={(event) => event.target.select()} />
                  <button type="button" onClick={() => void copy(item.link!)}>
                    {t("복사")}
                  </button>
                  <button type="button" onClick={() => void stop(item)}>
                    {t("공유 멈추기")}
                  </button>
                </div>
              )}
              {item.status === "stopped" && <span>{t("공유를 멈췄습니다")}</span>}
              {item.error && <span role="alert">{item.error}</span>}
            </article>
          ))
        )}
      </div>
      <footer className={styles.windowStatus}>
        <span>{t("링크는 만든 시점부터 1시간 동안 열립니다.")}</span>
      </footer>
    </section>
  );
}
