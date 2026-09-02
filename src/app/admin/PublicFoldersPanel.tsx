"use client";

import QrCodeToggle from "../QrCodeToggle";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiPath } from "@/lib/client/api-path";
import { translate, type Locale } from "@/lib/i18n";
import { ROLE_LABELS, USER_ROLES, type UserRole } from "@/lib/roles";
import styles from "./admin.module.css";

// 공개 폴더 관리 패널(#10) — 설정 화면의 별도 탭. 목록·생성·설정 변경·
// 등록 해제를 담당한다. 파일 자체는 여기서 다루지 않는다 — 관리자는 공개
// 폴더 화면(/public/<token>)에서 데스크처럼 보고 아이콘 위치까지 바꾼다.

interface AdminPublicFolder {
  id: string;
  folderId: string;
  name: string;
  enabled: boolean;
  opensAt: string | null;
  closesAt: string | null;
  maxTotalBytes: number | null;
  maxFileBytes: number | null;
  maxFiles: number | null;
  minRole: UserRole | null;
  userIds: string[];
  url: string;
  missing: boolean;
}

interface BaseUser {
  id: string;
  name: string;
  email: string;
  status: string;
}

const GIB = 1024 * 1024 * 1024;

function bytesAsInputGiB(value: number | null): string {
  // 왕복 손실을 없앤다 — 2자리 반올림은 1MiB(≈0.000977 GiB)를 "0"으로
  // 뭉개, 재진입 시 저장이 막히고(0 이하 거부) 필드를 비우면 무제한으로
  // 바뀐다. 6자리까지 표현하고 꼬리 0만 버린다.
  return value === null ? "" : String(Number((value / GIB).toFixed(6)));
}

function bytesFromInputGiB(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * GIB);
}

// datetime-local 입력(관리자 브라우저 로컬 시간) ↔ UTC ISO 저장값 변환.
function isoToLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

interface SettingsFormState {
  enabled: boolean;
  opensAt: string; // datetime-local 값
  closesAt: string;
  maxTotalGiB: string;
  maxFileGiB: string;
  maxFiles: string;
  minRole: UserRole | "";
  userIds: string[];
}

function formStateOf(folder: AdminPublicFolder): SettingsFormState {
  return {
    enabled: folder.enabled,
    opensAt: isoToLocalInput(folder.opensAt),
    closesAt: isoToLocalInput(folder.closesAt),
    maxTotalGiB: bytesAsInputGiB(folder.maxTotalBytes),
    maxFileGiB: bytesAsInputGiB(folder.maxFileBytes),
    maxFiles: folder.maxFiles === null ? "" : String(folder.maxFiles),
    minRole: folder.minRole ?? "",
    userIds: folder.userIds,
  };
}

// 폼 상태 → PATCH body. 형식이 어긋나면 오류 문구. baseline(저장값의 표시
// 형태)과 같은 필드는 body에서 뺀다 — 표시 변환(GiB 반올림·분 단위 절삭)이
// 손대지 않은 값까지 재양자화해 저장하는 것을 막는다(#10 리뷰).
function patchFromForm(
  form: SettingsFormState,
  baseline: SettingsFormState,
): { body: Record<string, unknown> } | { error: string } {
  const opensAt = localInputToIso(form.opensAt);
  const closesAt = localInputToIso(form.closesAt);
  if (opensAt === undefined || closesAt === undefined) {
    return { error: "공개 시각 값을 확인해 주세요" };
  }
  if (
    opensAt !== null &&
    closesAt !== null &&
    Date.parse(opensAt) >= Date.parse(closesAt)
  ) {
    return { error: "공개 종료 시각은 시작 시각보다 뒤여야 합니다" };
  }
  const maxTotalBytes = bytesFromInputGiB(form.maxTotalGiB);
  const maxFileBytes = bytesFromInputGiB(form.maxFileGiB);
  if (maxTotalBytes === undefined || maxFileBytes === undefined) {
    return { error: "용량 제한 값을 확인해 주세요" };
  }
  let maxFiles: number | null = null;
  if (form.maxFiles.trim()) {
    const parsed = Number(form.maxFiles.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
      return { error: "파일 개수 제한 값을 확인해 주세요" };
    }
    maxFiles = parsed;
  }
  const body: Record<string, unknown> = {};
  if (form.enabled !== baseline.enabled) body.enabled = form.enabled;
  if (form.opensAt !== baseline.opensAt) body.opensAt = opensAt;
  if (form.closesAt !== baseline.closesAt) body.closesAt = closesAt;
  if (form.maxTotalGiB !== baseline.maxTotalGiB) {
    body.maxTotalBytes = maxTotalBytes;
  }
  if (form.maxFileGiB !== baseline.maxFileGiB) body.maxFileBytes = maxFileBytes;
  if (form.maxFiles !== baseline.maxFiles) body.maxFiles = maxFiles;
  if (form.minRole !== baseline.minRole) {
    body.minRole = form.minRole === "" ? null : form.minRole;
  }
  if (
    form.userIds.length !== baseline.userIds.length ||
    form.userIds.some((id, index) => id !== baseline.userIds[index])
  ) {
    body.userIds = form.userIds;
  }
  return { body };
}

export default function PublicFoldersPanel({
  locale,
  active,
}: {
  locale: Locale;
  active: boolean;
}) {
  const router = useRouter();
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  const [folders, setFolders] = useState<AdminPublicFolder[] | null>(null);
  const [users, setUsers] = useState<BaseUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [createName, setCreateName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // 상태 라벨용 기준 시각 — 목록을 불러온 시점의 스냅샷(렌더 중 Date.now()
  // 호출은 순수성 규칙 위반이라 로드 시점에 고정한다).
  const [loadedAt, setLoadedAt] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void (async () => {
      try {
        const [folderResponse, userResponse] = await Promise.all([
          fetch(apiPath("/api/admin/public-folders"), { cache: "no-store" }),
          fetch(apiPath("/api/admin/users"), { cache: "no-store" }),
        ]);
        if (!alive) return;
        if (folderResponse.status === 401 || folderResponse.status === 403) {
          router.replace("/files");
          return;
        }
        const folderBody = (await folderResponse.json().catch(() => null)) as {
          folders?: AdminPublicFolder[];
        } | null;
        const userBody = (await userResponse.json().catch(() => null)) as {
          users?: BaseUser[];
        } | null;
        if (!alive) return;
        if (!folderResponse.ok || !Array.isArray(folderBody?.folders)) {
          setError(t("공개 폴더 목록을 불러오지 못했습니다"));
          return;
        }
        setError(null);
        setFolders(folderBody.folders);
        setLoadedAt(Date.now());
        setUsers(
          (userBody?.users ?? []).filter((user) => user.status === "approved"),
        );
      } catch {
        if (alive) setError(t("공개 폴더 목록을 불러오지 못했습니다"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, reloadKey, router, t]);

  async function api(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(apiPath(path), { cache: "no-store", ...init });
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throw new Error(
        typeof body?.error === "string" ? t(body.error) : t("요청에 실패했습니다"),
      );
    }
    return body ?? {};
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("요청에 실패했습니다"));
    } finally {
      setBusy(false);
    }
  }

  const createFolder = () =>
    run(async () => {
      await api("/api/admin/public-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName }),
      });
      setCreateName("");
      setNotice(t("공개 폴더를 만들었습니다. 주소를 복사해 나눠 주세요."));
      reload();
    });

  const saveSettings = (folder: AdminPublicFolder) =>
    run(async () => {
      if (!form) return;
      const parsed = patchFromForm(form, formStateOf(folder));
      if ("error" in parsed) {
        throw new Error(t(parsed.error));
      }
      // 바뀐 필드가 없으면 서버를 부르지 않는다 — 빈 PATCH는 400이다.
      if (Object.keys(parsed.body).length > 0) {
        await api(`/api/admin/public-folders/${folder.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.body),
        });
      }
      setNotice(t("저장했습니다"));
      reload();
    });

  const removeRegistration = (folder: AdminPublicFolder) =>
    run(async () => {
      await api(`/api/admin/public-folders/${folder.id}`, { method: "DELETE" });
      setConfirmRemove(null);
      if (openId === folder.id) setOpenId(null);
      setNotice(t("등록을 해제했습니다. 파일은 데스크에 남아 있습니다."));
      reload();
    });

  const copyUrl = async (folder: AdminPublicFolder) => {
    const url = `${window.location.origin}${folder.url}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice(t("주소를 복사했습니다"));
    } catch {
      setNotice(url);
    }
  };

  function statusLabel(folder: AdminPublicFolder): string {
    if (folder.missing) return t("대상 없음");
    if (!folder.enabled) return t("꺼짐");
    const now = loadedAt;
    if (folder.opensAt !== null && now < Date.parse(folder.opensAt)) {
      return t("공개 전");
    }
    if (folder.closesAt !== null && now >= Date.parse(folder.closesAt)) {
      return t("공개 종료");
    }
    return t("공개 중");
  }

  return (
    <section aria-labelledby="public-folders-title">
      <div className={styles.window}>
        <header className={styles.windowTitlebar}>
          <span className={styles.windowTitle}>
            <h2 id="public-folders-title">{t("공개 폴더")}</h2>
          </span>
          <span className={styles.windowMeta}>PUBLIC</span>
        </header>
        <div className={styles.windowBody}>
          <p className={styles.muted}>
            {t(
              "로그인 없이 주소만으로 파일을 받고 올리는 폴더입니다. 하위 폴더는 만들 수 없고, 상한과 공개 시간은 서버가 지킵니다.",
            )}
          </p>

          {error && (
            <p role="alert" className={styles.errorMessage}>
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}

          <form
            className={styles.createForm}
            onSubmit={(event) => {
              event.preventDefault();
              void createFolder();
            }}
          >
            <label className={styles.field}>
              <span>{t("새 공개 폴더 이름")}</span>
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                maxLength={40}
                className={styles.select}
                disabled={busy}
              />
            </label>
            <button
              type="submit"
              className={styles.pixelButton}
              disabled={busy || !createName.trim()}
            >
              {t("만들기")}
            </button>
          </form>

          {folders === null ? (
            <p>{t("불러오는 중…")}</p>
          ) : folders.length === 0 ? (
            <p className={styles.muted}>{t("아직 공개 폴더가 없습니다.")}</p>
          ) : (
            <ul className={styles.plainList}>
              {folders.map((folder) => {
                const opened = openId === folder.id;
                return (
                  <li key={folder.id}>
                    <div className={styles.folderHead}>
                      <strong>{folder.name}</strong>
                      <span className={styles.statusBadge}>
                        {statusLabel(folder)}
                      </span>
                    </div>
                    <div className={styles.folderActions}>
                      <button
                        type="button"
                        className={styles.pixelButton}
                        onClick={() => void copyUrl(folder)}
                      >
                        {t("주소 복사")}
                      </button>
                      <QrCodeToggle
                        value={`${window.location.origin}${folder.url}`}
                        label="QR"
                        closeLabel={t("닫기")}
                        className={styles.pixelButton}
                      />
                      <button
                        type="button"
                        className={styles.pixelButton}
                        aria-expanded={opened}
                        onClick={() => {
                          if (opened) {
                            setOpenId(null);
                            setForm(null);
                            return;
                          }
                          setOpenId(folder.id);
                          setForm(formStateOf(folder));
                        }}
                      >
                        {opened ? t("접기") : t("설정")}
                      </button>
                      {/* 파일은 공개 폴더 화면에서 다룬다 — 관리자는 거기서
                          아이콘을 끌어 방문자가 보는 위치를 바꾼다. */}
                      {!folder.missing && (
                        <a
                          href={folder.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`${styles.pixelButton} ${styles.folderOpenLink}`}
                        >
                          {t("공개 폴더 열기")}
                        </a>
                      )}
                      {confirmRemove === folder.id ? (
                        <span className={styles.folderRemove}>
                          <span className={styles.muted}>
                            {t("정말 해제할까요?")}
                          </span>
                          <button
                            type="button"
                            className={`${styles.pixelButton} ${styles.dangerButton}`}
                            disabled={busy}
                            onClick={() => void removeRegistration(folder)}
                          >
                            {t("등록 해제")}
                          </button>
                          <button
                            type="button"
                            className={styles.pixelButton}
                            onClick={() => setConfirmRemove(null)}
                          >
                            {t("취소")}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`${styles.pixelButton} ${styles.dangerButton} ${styles.folderRemove}`}
                          onClick={() => setConfirmRemove(folder.id)}
                        >
                          {t("등록 해제")}
                        </button>
                      )}
                    </div>
                    {folder.missing && (
                      <p className={styles.muted}>
                        {t(
                          "대상 폴더가 지워졌거나 바뀌어 주소가 닫혀 있습니다. 등록을 해제해 정리하세요.",
                        )}
                      </p>
                    )}

                    {opened && form && (
                      <div className={styles.folderDetail}>
                        <form
                          className={styles.folderSettings}
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveSettings(folder);
                          }}
                        >
                          <label className={styles.field}>
                            <span>{t("공개 상태")}</span>
                            <select
                              className={styles.select}
                              value={form.enabled ? "on" : "off"}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? {
                                        ...current,
                                        enabled: event.target.value === "on",
                                      }
                                    : current,
                                )
                              }
                            >
                              <option value="on">{t("켜짐")}</option>
                              <option value="off">{t("꺼짐")}</option>
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span>{t("공개 시작")}</span>
                            <input
                              type="datetime-local"
                              className={styles.select}
                              value={form.opensAt}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? { ...current, opensAt: event.target.value }
                                    : current,
                                )
                              }
                            />
                          </label>
                          <label className={styles.field}>
                            <span>{t("공개 종료 시각")}</span>
                            <input
                              type="datetime-local"
                              className={styles.select}
                              value={form.closesAt}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? { ...current, closesAt: event.target.value }
                                    : current,
                                )
                              }
                            />
                          </label>
                          <label className={styles.field}>
                            <span>{t("총 용량 제한 (GiB)")}</span>
                            <input
                              inputMode="decimal"
                              className={styles.select}
                              value={form.maxTotalGiB}
                              placeholder={t("비우면 제한 없음")}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? {
                                        ...current,
                                        maxTotalGiB: event.target.value,
                                      }
                                    : current,
                                )
                              }
                            />
                          </label>
                          <label className={styles.field}>
                            <span>{t("파일 1개 최대 크기 (GiB)")}</span>
                            <input
                              inputMode="decimal"
                              className={styles.select}
                              value={form.maxFileGiB}
                              placeholder={t("비우면 제한 없음")}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? {
                                        ...current,
                                        maxFileGiB: event.target.value,
                                      }
                                    : current,
                                )
                              }
                            />
                          </label>
                          <label className={styles.field}>
                            <span>{t("파일 개수 제한")}</span>
                            <input
                              inputMode="numeric"
                              className={styles.select}
                              value={form.maxFiles}
                              placeholder={t("비우면 제한 없음")}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? { ...current, maxFiles: event.target.value }
                                    : current,
                                )
                              }
                            />
                          </label>
                          <label className={styles.field}>
                            <span>{t("접근 제한 — 역할 최소선")}</span>
                            <select
                              className={styles.select}
                              value={form.minRole}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? {
                                        ...current,
                                        minRole: event.target.value as
                                          | UserRole
                                          | "",
                                      }
                                    : current,
                                )
                              }
                            >
                              <option value="">
                                {t("없음 — 누구나(외부 포함)")}
                              </option>
                              {USER_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {t(ROLE_LABELS[role])}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={styles.field}>
                            <span>{t("접근 제한 — 개인 지정 (OR)")}</span>
                            <select
                              multiple
                              className={styles.select}
                              value={form.userIds}
                              onChange={(event) =>
                                setForm((current) =>
                                  current
                                    ? {
                                        ...current,
                                        userIds: Array.from(
                                          event.target.selectedOptions,
                                        ).map((option) => option.value),
                                      }
                                    : current,
                                )
                              }
                            >
                              {users.map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.name} ({user.email})
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="submit"
                            className={styles.pixelButton}
                            disabled={busy}
                          >
                            {t("저장")}
                          </button>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
