"use client";

import { apiPath } from "@/lib/client/api-path";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import styles from "./desktop.module.css";

type ShareRole = "reader" | "writer";
type SharePermissionState = "active" | "recovery";

type ShareUser = {
  id: string;
  email: string;
  name: string;
};

type SharePermission = {
  permissionId: string;
  targetUserId: string;
  email: string;
  name: string;
  role: ShareRole;
  state?: SharePermissionState;
  createdAt: string;
  updatedAt: string;
};

type ShareResponse = {
  users: ShareUser[];
  permissions: SharePermission[];
};

type ShareDialogProps = {
  entry: {
    id: string;
    name: string;
    isFolder: boolean;
  };
  locale: Locale;
  onClose: () => void;
  onNotice: (message: string) => void;
};

const panelStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  flexDirection: "column",
  gap: 12,
  padding: 14,
  background: "#fff8e7",
  border: "2px solid #4f4853",
  boxShadow: "inset 2px 2px 0 #d8c7a5",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  minHeight: 40,
  padding: "7px 9px",
  color: "#1b1b2f",
  font: "inherit",
  background: "#fff8e7",
  border: "2px solid #4f4853",
  boxShadow: "inset 2px 2px 0 #b9aa8e",
};

const compactButtonStyle: CSSProperties = {
  minHeight: 36,
  padding: "6px 10px",
  border: "2px solid #10172b",
  whiteSpace: "nowrap",
};

function isShareRole(value: unknown): value is ShareRole {
  return value === "reader" || value === "writer";
}

function isShareUser(value: unknown): value is ShareUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<ShareUser>;
  return (
    typeof user.id === "string" &&
    typeof user.email === "string" &&
    typeof user.name === "string"
  );
}

function isSharePermission(value: unknown): value is SharePermission {
  if (!value || typeof value !== "object") return false;
  const permission = value as Partial<SharePermission>;
  return (
    typeof permission.permissionId === "string" &&
    typeof permission.targetUserId === "string" &&
    typeof permission.email === "string" &&
    typeof permission.name === "string" &&
    isShareRole(permission.role) &&
    (permission.state === undefined ||
      permission.state === "active" ||
      permission.state === "recovery")
  );
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function isAbortError(value: unknown) {
  return value instanceof DOMException && value.name === "AbortError";
}

export default function ShareDialog({
  entry,
  locale,
  onClose,
  onNotice,
}: ShareDialogProps) {
  const router = useRouter();
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const [users, setUsers] = useState<ShareUser[]>([]);
  const [permissions, setPermissions] = useState<SharePermission[]>([]);
  const [draftRoles, setDraftRoles] = useState<Record<string, ShareRole>>({});
  const [targetUserId, setTargetUserId] = useState("");
  const [newRole, setNewRole] = useState<ShareRole>("reader");
  const [sendNotificationEmail, setSendNotificationEmail] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const apiJson = useCallback(
    async function apiJson<T>(pathname: string, init: RequestInit): Promise<T> {
      const response = await fetch(pathname, init);
      if (response.status === 401) {
        router.replace("/");
        throw new Error("세션이 만료되었습니다");
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "요청에 실패했습니다");
      }
      return body as T;
    },
    [router],
  );

  const loadShares = useCallback(
    async (showLoading = true) => {
      loadControllerRef.current?.abort();
      const controller = new AbortController();
      loadControllerRef.current = controller;
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const body = await apiJson<ShareResponse>(
          apiPath(`/api/drive/share?id=${encodeURIComponent(entry.id)}`),
          { method: "GET", cache: "no-store", signal: controller.signal },
        );
        if (loadControllerRef.current !== controller) return;
        const nextUsers = Array.isArray(body.users)
          ? body.users.filter(isShareUser)
          : [];
        const nextPermissions = Array.isArray(body.permissions)
          ? body.permissions.filter(isSharePermission)
          : [];
        const sharedUserIds = new Set(
          nextPermissions.map((permission) => permission.targetUserId),
        );
        const availableUsers = nextUsers.filter(
          (user) => !sharedUserIds.has(user.id),
        );
        setUsers(nextUsers);
        setPermissions(nextPermissions);
        setStale(false);
        setDraftRoles(
          Object.fromEntries(
            nextPermissions.map((permission) => [
              permission.permissionId,
              permission.role,
            ]),
          ),
        );
        setTargetUserId((current) =>
          availableUsers.some((user) => user.id === current)
            ? current
            : availableUsers[0]?.id ?? "",
        );
      } catch (loadError) {
        if (
          isAbortError(loadError) ||
          loadControllerRef.current !== controller
        ) {
          return;
        }
        setError(
          errorMessage(loadError, "공유 정보를 불러오지 못했습니다"),
        );
        setStale(true);
        return false;
      } finally {
        if (loadControllerRef.current === controller) setLoading(false);
      }
      return true;
    },
    [apiJson, entry.id],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadShares(), 0);
    return () => {
      window.clearTimeout(timer);
      loadControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
    };
  }, [loadShares]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const sharedUserIds = new Set(
    permissions.map((permission) => permission.targetUserId),
  );
  const availableUsers = users.filter((user) => !sharedUserIds.has(user.id));
  const busy = busyKey !== null;

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  function closeDialog() {
    loadControllerRef.current?.abort();
    mutationControllerRef.current?.abort();
    onClose();
  }

  async function createPermission() {
    if (!targetUserId || busy) return;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusyKey("create");
    setError(null);
    try {
      await apiJson(apiPath("/api/drive/share"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          targetUserId,
          role: newRole,
          sendNotificationEmail,
        }),
        signal: controller.signal,
      });
      setSendNotificationEmail(false);
      const refreshed = await loadShares(false);
      if (!controller.signal.aborted) {
        onNotice(
          refreshed
            ? t("‘{name}’의 Google Drive 공유를 추가했습니다", {
                name: entry.name,
              })
            : t("공유는 반영됐지만 최신 권한 목록을 불러오지 못했습니다"),
        );
      }
    } catch (mutationError) {
      if (!controller.signal.aborted && !isAbortError(mutationError)) {
        setError(errorMessage(mutationError, "공유를 추가하지 못했습니다"));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) setBusyKey(null);
      }
    }
  }

  async function updatePermission(permission: SharePermission) {
    if (busy || permission.state === "recovery") return;
    const role = draftRoles[permission.permissionId] ?? permission.role;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusyKey(`update:${permission.permissionId}`);
    setError(null);
    try {
      await apiJson(apiPath("/api/drive/share"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          permissionId: permission.permissionId,
          role,
        }),
        signal: controller.signal,
      });
      const refreshed = await loadShares(false);
      if (!controller.signal.aborted) {
        onNotice(
          refreshed
            ? t("{name}님의 권한을 변경했습니다", {
                name: permission.name || permission.email,
              })
            : t("권한은 변경됐지만 최신 권한 목록을 불러오지 못했습니다"),
        );
      }
    } catch (mutationError) {
      if (!controller.signal.aborted && !isAbortError(mutationError)) {
        setError(errorMessage(mutationError, "권한을 변경하지 못했습니다"));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) setBusyKey(null);
      }
    }
  }

  async function revokePermission(permission: SharePermission) {
    if (busy) return;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusyKey(`delete:${permission.permissionId}`);
    setError(null);
    try {
      await apiJson(apiPath("/api/drive/share"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          permissionId: permission.permissionId,
        }),
        signal: controller.signal,
      });
      const refreshed = await loadShares(false);
      if (!controller.signal.aborted) {
        onNotice(
          refreshed
            ? t("{name}님의 공유 권한을 회수했습니다", {
                name: permission.name || permission.email,
              })
            : t("권한은 회수됐지만 최신 권한 목록을 불러오지 못했습니다"),
        );
      }
    } catch (mutationError) {
      if (!controller.signal.aborted && !isAbortError(mutationError)) {
        setError(
          errorMessage(mutationError, "공유 권한을 회수하지 못했습니다"),
        );
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) setBusyKey(null);
      }
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (activeIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        style={{
          display: "flex",
          width: "min(560px, 100%)",
          maxHeight: "calc(100dvh - 36px)",
          flexDirection: "column",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className={styles.dialogTitlebar}>
          <strong id={titleId}>{t("Google Drive로 공유")}</strong>
          <button
            type="button"
            aria-label={t("닫기")}
            onClick={closeDialog}
          >
            ×
          </button>
        </header>

        <div
          className={styles.dialogBody}
          style={{
            alignItems: "stretch",
            overflowY: "auto",
            overscrollBehavior: "contain",
          }}
        >
          <div
            style={{
              display: "flex",
              width: "100%",
              minWidth: 0,
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <strong style={{ overflowWrap: "anywhere" }}>‘{entry.name}’</strong>
            <span style={{ flex: "0 0 auto", color: "#666b78" }}>
              {entry.isFolder ? t("폴더") : t("파일")}
            </span>
          </div>

          <p
            id={descriptionId}
            style={{
              width: "100%",
              padding: 12,
              color: "#31364a",
              background: "#e5eef0",
              border: "2px solid #51658d",
            }}
          >
            <span>
              {t("받는 사람의 Google Drive 공유 문서함에도 표시됩니다.")}
            </span>
            <small>{t("ShareDesk 안의 공동 접근은 바뀌지 않습니다.")}</small>
          </p>

          {loading ? (
            <p role="status" style={{ width: "100%", paddingBlock: 18 }}>
              {t("공유 정보를 불러오는 중입니다…")}
            </p>
          ) : (
            <>
              <form
                style={panelStyle}
                aria-label={t("새 Google Drive 공유")}
                onSubmit={(event) => {
                  event.preventDefault();
                  void createPermission();
                }}
              >
                <strong>{t("새로 공유")}</strong>
                <label>
                  <span>{t("받는 사람")}</span>
                  <select
                    style={fieldStyle}
                    value={targetUserId}
                    disabled={busy || stale || availableUsers.length === 0}
                    onChange={(event) => setTargetUserId(event.target.value)}
                  >
                    {availableUsers.length === 0 ? (
                      <option value="">{t("공유할 수 있는 새 사용자가 없습니다")}</option>
                    ) : (
                      availableUsers.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name || user.email} · {user.email}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label>
                  <span>{t("권한")}</span>
                  <select
                    style={fieldStyle}
                    value={newRole}
                    disabled={busy || stale}
                    onChange={(event) =>
                      setNewRole(event.target.value as ShareRole)
                    }
                  >
                    <option value="reader">{t("보기")}</option>
                    <option value="writer">{t("편집")}</option>
                  </select>
                </label>
                <label
                  style={{
                    width: "100%",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 9,
                  }}
                >
                  <input
                    type="checkbox"
                    style={{
                      width: 20,
                      height: 20,
                      flex: "0 0 auto",
                      padding: 0,
                      background: "transparent",
                      border: 0,
                      accentColor: "#2d5c5b",
                      boxShadow: "none",
                    }}
                    checked={sendNotificationEmail}
                    disabled={busy || stale}
                    onChange={(event) =>
                      setSendNotificationEmail(event.target.checked)
                    }
                  />
                  <span>{t("Google 알림 이메일 보내기 (기본 꺼짐)")}</span>
                </label>
                <button
                  type="submit"
                  className={styles.primaryButton}
                  style={{ ...compactButtonStyle, alignSelf: "flex-end" }}
                  disabled={busy || stale || !targetUserId}
                >
                  {busyKey === "create" ? t("공유 중…") : t("공유하기")}
                </button>
              </form>

              <section style={panelStyle} aria-labelledby={`${titleId}-current`}>
                <strong id={`${titleId}-current`}>
                  {t("현재 직접 공유 권한")}
                </strong>
                {permissions.length === 0 ? (
                  <span style={{ color: "#666b78", lineHeight: 1.5 }}>
                    {t("ShareDesk에서 추가한 직접 권한이 없습니다.")}
                  </span>
                ) : (
                  <ul
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      margin: 0,
                      padding: 0,
                      listStyle: "none",
                    }}
                  >
                    {permissions.map((permission) => {
                      const draftRole =
                        draftRoles[permission.permissionId] ?? permission.role;
                      const needsRecovery = permission.state === "recovery";
                      return (
                        <li
                          key={permission.permissionId}
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            gap: 8,
                            paddingTop: 10,
                            borderTop: "2px solid #d8c7a5",
                          }}
                        >
                          <span
                            style={{
                              display: "flex",
                              minWidth: 0,
                              flex: "1 1 180px",
                              flexDirection: "column",
                              gap: 3,
                              overflowWrap: "anywhere",
                            }}
                          >
                            <strong>{permission.name || permission.email}</strong>
                            {needsRecovery && (
                              <small
                                style={{
                                  alignSelf: "flex-start",
                                  padding: "2px 6px",
                                  color: "#7d2632",
                                  fontWeight: 700,
                                  background: "#f8d9d3",
                                  border: "1px solid #a53c46",
                                }}
                              >
                                {t("회수 필요")}
                              </small>
                            )}
                            <small style={{ color: "#666b78" }}>
                              {permission.email}
                            </small>
                          </span>
                          <span
                            style={{
                              display: "flex",
                              minWidth: 0,
                              flex: "1 1 238px",
                              flexWrap: "wrap",
                              justifyContent: "flex-end",
                              gap: 6,
                            }}
                          >
                            <select
                              style={{ ...fieldStyle, width: "auto", flex: "1 1 92px" }}
                              aria-label={t("{name} 권한", {
                                name: permission.name || permission.email,
                              })}
                              value={draftRole}
                              disabled={busy || stale || needsRecovery}
                              onChange={(event) =>
                                setDraftRoles((current) => ({
                                  ...current,
                                  [permission.permissionId]: event.target
                                    .value as ShareRole,
                                }))
                              }
                            >
                              <option value="reader">{t("보기")}</option>
                              <option value="writer">{t("편집")}</option>
                            </select>
                            <button
                              type="button"
                              className={styles.secondaryButton}
                              style={compactButtonStyle}
                              disabled={
                                busy ||
                                stale ||
                                needsRecovery ||
                                draftRole === permission.role
                              }
                              onClick={() => void updatePermission(permission)}
                            >
                              {busyKey === `update:${permission.permissionId}`
                                ? t("변경 중…")
                                : t("변경")}
                            </button>
                            <button
                              type="button"
                              className={styles.dangerButton}
                              style={compactButtonStyle}
                              disabled={busy || stale}
                              onClick={() => void revokePermission(permission)}
                            >
                              {busyKey === `delete:${permission.permissionId}`
                                ? t("해제 중…")
                                : t("공유 해제")}
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}

          {error && (
            <p
              role="alert"
              style={{
                width: "100%",
                padding: 10,
                color: "#7d2632",
                background: "#f8d9d3",
                border: "2px solid #a53c46",
              }}
            >
              <span>{t(error)}</span>
              {!loading && stale && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  style={{ ...compactButtonStyle, alignSelf: "flex-start" }}
                  disabled={busy}
                  onClick={() => void loadShares()}
                >
                  {t("다시 시도")}
                </button>
              )}
            </p>
          )}

          {busy && (
            <span role="status" aria-live="polite" style={{ width: "100%" }}>
              {t("Google Drive 공유 권한을 처리하는 중입니다…")}
            </span>
          )}

          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={closeDialog}
            >
              {t("닫기")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
