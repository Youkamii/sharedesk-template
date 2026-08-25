"use client";

import { apiPath } from "@/lib/client/api-path";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import {
  planDeskImport,
  runDeskImport,
  type ImportPlan,
  type ImportTask,
} from "@/lib/client/desk-import";
import {
  isFolderExistsConflict,
  matchExistingFolder,
} from "@/lib/client/folder-upload";
import styles from "./desktop.module.css";

type Props = {
  locale: Locale;
  maximized: boolean;
  zIndex: number;
  active: boolean;
  parentId: string;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onNotice: (message: string) => void;
  onImported: () => void;
  onActivate: () => void;
};

type Phase = "input" | "planned" | "running" | "done";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

export default function DeskImportWindow({
  locale,
  maximized,
  zIndex,
  active,
  parentId,
  onClose,
  onMinimize,
  onToggleMaximize,
  onNotice,
  onImported,
  onActivate,
}: Props) {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<ImportTask[]>([]);
  const [checking, setChecking] = useState(false);
  const stopRef = useRef(false);
  // 확인이 도는 동안 주소가 바뀌었는지 보려고 최신 값을 따로 들고 있는다.
  const linkRef = useRef("");
  useEffect(() => {
    linkRef.current = link;
  }, [link]);

  // 창을 닫거나 최소화하면 이 컴포넌트가 사라지는데 복사 루프는 클로저를 붙잡고
  // 계속 돈다. 그러면 진행률도 멈춤 버튼도 없이 파일이 계속 들어온다.
  // 사라질 때 루프도 함께 멈춘다.
  useEffect(() => {
    return () => {
      stopRef.current = true;
    };
  }, []);

  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  const readManifest = useCallback(
    async (entryId: string | null) => {
      const response = await postJson(apiPath("/api/drive/import/manifest"), {
        url: link,
        entryId,
      });
      if (response.status === 401) {
        router.replace("/");
        return null;
      }
      if (!response.ok) return null;
      return (await response.json().catch(() => null)) as null | {
        kind: "file" | "folder";
        name: string;
        size: number | null;
        entries: { id: string; name: string; isFolder: boolean; size: number | null }[] | null;
      };
    },
    [link, router],
  );

  async function checkLink() {
    // 연타하면 순회가 겹치고, 도는 동안 주소를 바꾸면 계획과 입력이 어긋난 채
    // 복사가 시작된다.
    if (checking) return;
    const target = link;
    setChecking(true);
    setError(null);
    setPlan(null);
    try {
      const next = await planDeskImport({ readManifest });
      // 확인하는 사이 주소가 바뀌었으면 이 결과는 버린다.
      if (linkRef.current !== target) return;
      if (!next) {
        setError(t("링크를 확인하지 못했습니다. 주소와 만료 여부를 살펴 주세요."));
        return;
      }
      setPlan(next);
      setPhase("planned");
    } catch {
      if (linkRef.current !== target) return;
      setError(t("링크를 확인하지 못했습니다. 주소와 만료 여부를 살펴 주세요."));
    } finally {
      setChecking(false);
    }
  }

  async function startImport() {
    if (!plan) return;
    stopRef.current = false;
    setPhase("running");
    setDone(0);
    setFailed([]);
    try {
      const result = await runDeskImport(
        plan,
        parentId,
        {
          ensureFolder: async (name, folderParentId) => {
            const response = await postJson(apiPath("/api/drive/mkdir"), {
              name,
              parentId: folderParentId,
            });
            if (response.ok) {
              const body = (await response.json()) as { entry: { id: string } };
              return body.entry.id;
            }
            // 같은 이름 폴더가 이미 있으면 그 안으로 합친다. 그러지 않으면 같은
            // 링크를 두 번 받거나 이름이 겹치기만 해도 한 개도 못 옮긴다.
            const body = await response.json().catch(() => null);
            if (isFolderExistsConflict({ status: response.status, body })) {
              const listed = await fetch(
                apiPath(`/api/drive/list?folderId=${encodeURIComponent(folderParentId)}`),
                { cache: "no-store" },
              );
              if (listed.ok) {
                const data = (await listed.json()) as {
                  entries?: { id: string; name: string; isFolder: boolean }[];
                };
                const existing = matchExistingFolder(data.entries ?? [], name);
                if (existing) return existing;
              }
            }
            throw new Error("mkdir");
          },
          importFile: async (task, folderParentId) => {
            const response = await postJson(
              apiPath(`/api/drive/import?parentId=${encodeURIComponent(folderParentId)}`),
              { url: link, entryId: task.entryId },
            );
            if (!response.ok) throw new Error("import");
          },
        },
        {
          onProgress: (copied) => setDone(copied),
          onFailure: (task) => setFailed((current) => [...current, task]),
          shouldStop: () => stopRef.current,
        },
      );
      setPhase("done");
      onImported();
      if (result.failed.length === 0 && !result.stopped) {
        onNotice(t("{count}개를 받았습니다.", { count: result.copied }));
      } else if (result.stopped) {
        onNotice(t("받기를 멈췄습니다. {count}개까지 옮겼습니다.", {
          count: result.copied,
        }));
      } else {
        onNotice(
          t("{count}개를 받고 {failed}개를 실패했습니다.", {
            count: result.copied,
            failed: result.failed.length,
          }),
        );
      }
    } catch {
      setPhase("planned");
      setError(t("받는 중 문제가 생겼습니다."));
    }
  }

  const total = plan?.tasks.length ?? 0;
  // 파일이 하나도 없고 폴더 구조만 있는 링크도 받을 수 있어야 한다.
  const movable = total + (plan?.folders.length ?? 0);

  return (
    <section
      className={`${styles.folderWindow} ${styles.shareLinksWindow} ${active ? styles.activeWindow : ""} ${maximized ? styles.utilityMaximized : ""}`}
      style={{ zIndex }}
      aria-label={t("다른 데스크에서 받기")}
      onPointerDown={onActivate}
    >
      <header className={styles.windowTitlebar}>
        <strong>{t("다른 데스크에서 받기")}</strong>
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
      <div className={`${styles.shareLinksBody} ${styles.deskImportBody}`}>
        <p>
          {t("다른 ShareDesk에서 만든 공유 링크를 붙여넣으면 이 데스크로 복사합니다.")}
        </p>
        <label className={styles.deskImportField}>
          <span>{t("공유 링크 주소")}</span>
          <input
            type="url"
            value={link}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://…/api/share/…"
            disabled={phase === "running"}
            onChange={(event) => {
              setLink(event.target.value);
              setPhase("input");
              setPlan(null);
              setError(null);
            }}
          />
        </label>

        {error && <p role="alert">{error}</p>}

        {plan && phase !== "running" && (
          <div className={styles.deskImportSummary}>
            <p>
              {plan.isFolder
                ? t("폴더 “{name}” · 파일 {count}개", {
                    name: plan.rootName,
                    count: total,
                  })
                : t("파일 “{name}”", { name: plan.rootName })}
            </p>
            {plan.truncated && (
              <p role="alert">
                {t(
                  "항목이 너무 많거나 깊어 일부만 담았습니다. 안쪽 폴더의 링크를 따로 만들어 받아 주세요.",
                )}
              </p>
            )}
          </div>
        )}

        {phase === "running" && (
          <p role="status">
            {t("받는 중 {done}/{total}", { done, total })}
          </p>
        )}

        {phase === "done" && failed.length > 0 && (
          <div role="alert">
            <p>{t("받지 못한 항목 {count}개", { count: failed.length })}</p>
            <ul>
              {failed.slice(0, 10).map((task) => (
                <li key={`${task.parentPath.join("/")}/${task.name}`}>
                  {[...task.parentPath, task.name].join("/")}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.deskImportActions}>
          {phase === "running" ? (
            <button
              type="button"
              onClick={() => {
                stopRef.current = true;
              }}
            >
              {t("멈추기")}
            </button>
          ) : plan ? (
            <button type="button" onClick={startImport} disabled={movable === 0}>
              {t("이 데스크로 받기")}
            </button>
          ) : (
            <button
              type="button"
              onClick={checkLink}
              disabled={!link.trim() || checking}
            >
              {checking ? t("확인하는 중…") : t("링크 확인")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
