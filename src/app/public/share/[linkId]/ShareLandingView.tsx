"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { formatSize } from "@/lib/client/mobile-listing";
import { useVisitorDownloads } from "@/lib/client/visitor-downloads";
import { LOCALE_BCP47, translate, type Locale } from "@/lib/i18n";
import {
  formatShareRemaining,
  shareFileUrl,
  shareLandingPath,
  shareLinkRemaining,
  type ShareLandingModel,
} from "@/lib/share-landing";
import PixelFileIcon from "../../../files/PixelFileIcon";
import ShareLandingFrame from "./ShareLandingFrame";
import styles from "./share-landing.module.css";

// 공유·간이 링크 받기 화면(#17 B-3). 파일 링크: 이름·크기·종류 아이콘·보낸
// 사람·남은 시간·받기 단추·(안전한 형식이면) 작은 미리보기. 폴더 링크: 같은
// 틀에 목록·각 파일 받기·모두 받기(서버 zip 없이 3개씩 차례로).

type Translate = (text: string, vars?: Record<string, string | number>) => string;

// 텍스트 미리보기는 앞부분만 범위 요청으로 받는다 — 큰 로그 파일 전체를 읽지 않게.
const TEXT_PREVIEW_BYTES = 64 * 1024;

function subscribeNoop() {
  return () => {};
}

// 서버 HTML에는 없고 브라우저에서만 아는 값(시간대·PDF 뷰어 유무)은 hydration
// 뒤에 그린다 — 첫 렌더에서 읽으면 서버 HTML과 어긋난다.
function useBrowserValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(subscribeNoop, read, () => serverValue);
}

const readHydrated = () => true;
// 인라인 PDF를 그릴 수 없는 브라우저(안드로이드 Chrome 등)는 iframe이 빈 칸이
// 되거나 내려받기로 떨어진다 — 그릴 수 있다고 알려 준 브라우저에서만 넣는다.
const readPdfViewer = () =>
  (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled ===
  true;

function TextPreview({
  url,
  truncated,
  t,
}: {
  url: string;
  truncated: boolean;
  t: Translate;
}) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("preview");
        const bytes = new Uint8Array(await response.arrayBuffer());
        setText(new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES)));
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [url]);
  if (failed) return null;
  return (
    <figure className={styles.preview} aria-label={t("미리보기")}>
      <pre>{text ?? "…"}</pre>
      {truncated && <figcaption>{t("앞부분만 보여 줍니다")}</figcaption>}
    </figure>
  );
}

function FilePreview({
  model,
  t,
}: {
  model: ShareLandingModel;
  t: Translate;
}) {
  const hydrated = useBrowserValue(readHydrated, false);
  const pdfViewer = useBrowserValue(readPdfViewer, false);
  const [imageFailed, setImageFailed] = useState(false);
  const url = shareFileUrl(model.linkId, model.entryId, "preview");
  const { preview, name, size } = model.current;
  if (!preview || !hydrated) return null;
  if (preview === "image") {
    if (imageFailed) return null;
    return (
      <figure className={styles.preview} aria-label={t("미리보기")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} onError={() => setImageFailed(true)} />
      </figure>
    );
  }
  if (preview === "pdf") {
    if (!pdfViewer) return null;
    return (
      <figure className={styles.preview} aria-label={t("미리보기")}>
        <iframe src={url} title={t("미리보기")} />
      </figure>
    );
  }
  return (
    <TextPreview
      url={url}
      truncated={size !== null && size > TEXT_PREVIEW_BYTES}
      t={t}
    />
  );
}

export default function ShareLandingView({
  model,
  locale,
  renderedAt,
}: {
  model: ShareLandingModel;
  locale: Locale;
  // 서버가 그린 시각. 첫 화면의 남은 시간을 서버 HTML과 같게 맞춘다.
  renderedAt: number;
}) {
  const t = useCallback<Translate>(
    (text, vars) => translate(locale, text, vars),
    [locale],
  );

  const [now, setNow] = useState(renderedAt);
  const remaining = shareLinkRemaining(model.expiresAt, now);
  const closed = remaining.expired;
  // 1초마다 자기 시계로 다시 잰다. 닫히면 멈춘다. 첫 갱신은 0ms 타이머로
  // (effect 본문에서 바로 setState하면 연쇄 렌더 규칙에 걸린다).
  useEffect(() => {
    if (closed) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [closed]);

  const hydrated = useBrowserValue(readHydrated, false);
  const expiryText = hydrated
    ? new Intl.DateTimeFormat(LOCALE_BCP47[locale], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(model.expiresAt))
    : null;

  const downloads = useVisitorDownloads((entryId) =>
    shareFileUrl(model.linkId, entryId, "download"),
  );
  const { summary } = downloads;
  const files = (model.entries ?? []).filter((entry) => !entry.isFolder);
  const current = model.current;
  const showPath = model.kind === "folder" && model.entryId !== null;

  const nav =
    model.kind === "folder" ? (
      <nav className={styles.path} aria-label={t("위치")}>
        {showPath ? (
          <a href={shareLandingPath(model.linkId)}>{model.rootName}</a>
        ) : (
          <strong>{model.rootName}</strong>
        )}
        {showPath && (
          <>
            <span aria-hidden="true">/</span>
            <strong>{current.name}</strong>
          </>
        )}
      </nav>
    ) : undefined;

  return (
    <ShareLandingFrame
      label={model.kind === "folder" ? t("공유 폴더") : t("공유 파일")}
      labelledBy="share-landing-title"
      nav={nav}
      footer={
        expiryText ? (
          closed ? (
            t("이 링크는 {time}에 닫혔습니다", { time: expiryText })
          ) : (
            t("이 링크는 {time}에 닫힙니다", { time: expiryText })
          )
        ) : (
          <span aria-hidden="true">{" "}</span>
        )
      }
    >
      <div className={styles.hero}>
        <span className={styles.heroIcon} aria-hidden="true">
          <PixelFileIcon entry={current} size={64} />
        </span>
        <div className={styles.heroText}>
          <h1 id="share-landing-title" className={styles.name}>
            {current.name}
          </h1>
          {!current.isFolder && current.size !== null && (
            <p className={styles.meta}>{formatSize(current.size)}</p>
          )}
          {current.isFolder && (
            <p className={styles.meta}>
              {t("파일 {count}개", { count: files.length })}
            </p>
          )}
        </div>
      </div>

      <dl className={styles.facts}>
        {model.sender && (
          <>
            <dt>{t("보낸 사람")}</dt>
            <dd>{model.sender}</dd>
          </>
        )}
        <dt>{t("남은 시간")}</dt>
        <dd
          className={styles.countdown}
          data-closed={closed ? "true" : "false"}
          role="timer"
        >
          {formatShareRemaining(remaining, t)}
        </dd>
      </dl>

      {closed && (
        <p className={styles.closed} role="status">
          {t("이 링크는 닫혔습니다")}
        </p>
      )}

      {!current.isFolder && (
        <>
          <FilePreview model={model} t={t} />
          {closed ? (
            <span className={styles.primary} aria-disabled="true">
              {t("받기")}
            </span>
          ) : (
            <a
              className={styles.primary}
              href={shareFileUrl(model.linkId, model.entryId, "download")}
              download=""
            >
              {t("받기")}
            </a>
          )}
        </>
      )}

      {current.isFolder && (
        <>
          {(model.entries ?? []).length === 0 ? (
            <p className={styles.empty}>{t("빈 폴더입니다")}</p>
          ) : (
            <ul className={styles.list}>
              {(model.entries ?? []).map((entry) => (
                <li key={entry.id} className={styles.row}>
                  <a
                    className={styles.rowMain}
                    href={shareLandingPath(model.linkId, entry.id)}
                  >
                    <span className={styles.rowIcon} aria-hidden="true">
                      <PixelFileIcon entry={entry} size={30} />
                    </span>
                    <span className={styles.rowName}>
                      {entry.name}
                      {entry.isFolder ? "/" : ""}
                    </span>
                    {!entry.isFolder && (
                      <span className={styles.rowMeta}>
                        {formatSize(entry.size)}
                      </span>
                    )}
                  </a>
                  {!entry.isFolder &&
                    (closed ? (
                      <span className={styles.rowAction} aria-disabled="true">
                        {t("받기")}
                      </span>
                    ) : (
                      <a
                        className={styles.rowAction}
                        href={shareFileUrl(model.linkId, entry.id, "download")}
                        download=""
                        aria-label={t("{name} 받기", { name: entry.name })}
                      >
                        {t("받기")}
                      </a>
                    ))}
                </li>
              ))}
            </ul>
          )}
          <div className={styles.bulk}>
            <button
              type="button"
              className={styles.primary}
              disabled={closed || files.length === 0 || summary.active > 0}
              onClick={() => downloads.enqueue(files)}
            >
              {t("모두 받기 ({count})", { count: files.length })}
            </button>
            {summary.total > 0 && (
              <p className={styles.status} role="status">
                {summary.active > 0
                  ? t("내려받는 중 {done}/{total}", {
                      done: summary.done + summary.failed,
                      total: summary.total,
                    })
                  : summary.failed === 0
                    ? t("{count}개를 내려받았습니다", { count: summary.done })
                    : t("{done}개 받음 · {failed}개 실패", {
                        done: summary.done,
                        failed: summary.failed,
                      })}
              </p>
            )}
          </div>
        </>
      )}
    </ShareLandingFrame>
  );
}
