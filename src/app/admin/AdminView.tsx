"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import LanguageToggle from "@/app/LanguageToggle";
import { translate, type Locale } from "@/lib/i18n";
import {
  ROLE_LABELS,
  USER_ROLES,
  resolveUserRole,
  type UserRole,
} from "@/lib/roles";
import type { User } from "@/lib/users";
import styles from "./admin.module.css";

type InvitationState = "active" | "inactive" | "used" | "expired";
type InvitationUsageMode = "once" | "unlimited";

interface InvitationSummary {
  id: string;
  createdAt: string;
  createdByEmail: string;
  expiresAt: string;
  durationMinutes: number;
  usageMode: InvitationUsageMode;
  role: UserRole;
  usageCount: number;
  lastUsedAt: string | null;
  lastUsedByEmail: string | null;
  state: InvitationState;
  code: string | null;
}

type LastInvitationAccess = {
  invitationId: string;
  code: string;
};

interface OwnerRegistryStatus {
  enabled: boolean;
  unset: boolean;
  version: string;
  site: string | null;
  repository: string | null;
  error: string | null;
}

const STATUS_LABEL: Record<User["status"], string> = {
  pending: "코드 입력 대기",
  approved: "승인됨",
  blocked: "차단됨",
};

const STATUS_STYLE: Record<User["status"], string> = {
  pending: styles.statusPending,
  approved: styles.statusApproved,
  blocked: styles.statusBlocked,
};

const INVITE_LABEL: Record<InvitationState, string> = {
  active: "사용 가능",
  inactive: "비활성",
  used: "사용 완료",
  expired: "기간 만료",
};

const INVITE_STYLE: Record<InvitationState, string> = {
  active: styles.statusApproved,
  inactive: styles.statusInactive,
  used: styles.statusUsed,
  expired: styles.statusPending,
};

const USAGE_MODE_LABEL: Record<InvitationUsageMode, string> = {
  once: "1회용",
  unlimited: "기간 내 무제한",
};

type Translator = (
  text: string,
  vars?: Record<string, string | number>,
) => string;

function formatDate(value: string | null, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function formatDuration(minutes: number, t: Translator): string {
  if (minutes === 60) return t("1시간");
  if (minutes === 1_440) return t("24시간");
  if (minutes === 10_080) return t("7일");
  if (minutes === 43_200) return t("30일");
  return t("{분}분", { 분: minutes });
}

export default function AdminView({ locale }: { locale: Locale }) {
  const router = useRouter();
  const t = useCallback<Translator>(
    (text, vars) => translate(locale, text, vars),
    [locale],
  );
  const mutationInFlightRef = useRef(false);
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [lastAccess, setLastAccess] = useState<LastInvitationAccess | null>(null);
  const [ownerRegistry, setOwnerRegistry] =
    useState<OwnerRegistryStatus | null>(null);
  const [ownerRegistryBusy, setOwnerRegistryBusy] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    expiresInMinutes: 1_440,
    usageMode: "once" as InvitationUsageMode,
    role: "editor" as UserRole,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [userResponse, inviteResponse] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/invitations"),
      ]);
      if (
        userResponse.status === 401 ||
        userResponse.status === 403 ||
        inviteResponse.status === 401 ||
        inviteResponse.status === 403
      ) {
        router.replace("/files");
        return;
      }
      const [userBody, inviteBody] = await Promise.all([
        userResponse.json().catch(() => null),
        inviteResponse.json().catch(() => null),
      ]);
      if (!userResponse.ok) {
        throw new Error(userBody?.error ?? t("사용자 목록을 불러오지 못했습니다"));
      }
      if (!inviteResponse.ok) {
        throw new Error(inviteBody?.error ?? t("초대 목록을 불러오지 못했습니다"));
      }
      setUsers(userBody.users);
      setInvitations(inviteBody.invitations);
      setLastAccess((current) => {
        if (!current) return null;
        const invitation = inviteBody.invitations.find(
          (item: InvitationSummary) => item.id === current.invitationId,
        );
        return invitation?.state === "active" && invitation.code
          ? {
              invitationId: invitation.id,
              code: invitation.code,
            }
          : null;
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("관리 정보를 불러오지 못했습니다"),
      );
    } finally {
      setLoading(false);
    }
  }, [router, t]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void fetch("/api/admin/owner-registry", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 401 || response.status === 403) {
            router.replace("/files");
            return null;
          }
          const body = (await response.json().catch(() => null)) as
            | OwnerRegistryStatus
            | { error?: string }
            | null;
          if (!response.ok || !body || !("enabled" in body)) {
            throw new Error(
              body?.error ?? t("설치 등록부 상태를 확인하지 못했습니다"),
            );
          }
          return body;
        })
        .then((status) => {
          if (status) setOwnerRegistry(status);
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setError(
            caught instanceof Error
              ? caught.message
              : t("설치 등록부 상태를 확인하지 못했습니다"),
          );
        });
    }, 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [router, t]);

  async function recordCurrentInstallation() {
    if (!ownerRegistry?.enabled || ownerRegistryBusy) return;
    setOwnerRegistryBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/owner-registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (response.status === 401 || response.status === 403) {
        router.replace("/files");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        created?: boolean;
        error?: string;
        status?: OwnerRegistryStatus;
      } | null;
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? t("현재 설치 정보를 등록하지 못했습니다"));
      }
      if (body.status) setOwnerRegistry(body.status);
      setNotice(
        body.created
          ? t("ShareDesk {버전} 설치 정보를 등록했습니다.", {
              버전: ownerRegistry.version,
            })
          : t("ShareDesk {버전} 기록을 갱신했습니다.", {
              버전: ownerRegistry.version,
            }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("현재 설치 정보를 등록하지 못했습니다"),
      );
    } finally {
      setOwnerRegistryBusy(false);
    }
  }

  function beginMutation(operationId: string): boolean {
    if (mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    setBusyId(operationId);
    return true;
  }

  function finishMutation() {
    mutationInFlightRef.current = false;
    setBusyId(null);
  }

  async function act(id: string, action: string, sessionId?: string) {
    const operationId = sessionId
      ? `session:${id}:${sessionId}`
      : `user:${id}`;
    if (!beginMutation(operationId)) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, sessionId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? t("처리하지 못했습니다"));
      if (body?.warning) setNotice(body.warning);
      else if (action === "revoke-session") {
        setNotice(t("선택한 로그인을 끊었습니다"));
      }
      setConfirmRemoveId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("처리하지 못했습니다"));
    } finally {
      finishMutation();
    }
  }

  async function changeRole(id: string, role: UserRole) {
    if (!beginMutation(`user:${id}`)) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "role", role }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? t("처리하지 못했습니다"));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("처리하지 못했습니다"));
    } finally {
      finishMutation();
    }
  }

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginMutation("invite:create")) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inviteForm),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? t("초대 코드를 만들지 못했습니다"));
      }
      setLastAccess(
        body.invitation.state === "active" &&
          body.invitation.code
          ? {
              invitationId: body.invitation.id,
              code: body.invitation.code,
            }
          : null,
      );
      setInviteForm({
        expiresInMinutes: 1_440,
        usageMode: "once",
        role: "editor",
      });
      setNotice(t("초대 코드를 만들었습니다. 아래 코드를 전달해 주세요."));
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("초대 코드를 만들지 못했습니다"),
      );
    } finally {
      finishMutation();
    }
  }

  async function invitationAction(
    invitation: InvitationSummary,
    action: "toggle" | "rotate",
  ) {
    if (!beginMutation(`invite:${invitation.id}`)) return;
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "rotate"
            ? { id: invitation.id, action: "rotate" }
            : {
                id: invitation.id,
                action: "update",
                active: invitation.state !== "active",
              },
        ),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? t("초대를 바꾸지 못했습니다"));
      }
      if (action === "rotate") {
        setLastAccess(
          body.invitation.code
            ? {
                invitationId: body.invitation.id,
                code: body.invitation.code,
              }
            : null,
        );
        setNotice(
          t(
            "예전 코드를 무효화하고 같은 사용 기간의 새 코드를 만들었습니다. 사용 횟수와 마지막 사용 기록은 유지됩니다.",
          ),
        );
      } else if (
        body.invitation.state === "active" &&
        body.invitation.code
      ) {
        setLastAccess({
          invitationId: body.invitation.id,
          code: body.invitation.code,
        });
      } else {
        setLastAccess((current) =>
          current?.invitationId === invitation.id ? null : current,
        );
      }
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("초대를 바꾸지 못했습니다"),
      );
    } finally {
      finishMutation();
    }
  }

  async function copyInvitationValue(
    value: string,
    invitation: LastInvitationAccess,
  ) {
    if (mutationInFlightRef.current) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setNotice(t("초대 코드를 복사했습니다."));
    } catch {
      setLastAccess(invitation);
      setNotice(t("아래 코드를 직접 선택해 복사해 주세요."));
    }
  }

  const buttonClass = styles.pixelButton;
  const inputClass = styles.select;
  const pending = users.filter((user) => user.status === "pending");

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <div>
            <p className={styles.eyebrow}>SHAREDESK / ADMIN TOOL</p>
            <h1 className={styles.pageTitle}>{t("사용자 및 초대 관리")}</h1>
          </div>
        </div>
        <div className={styles.headerActions}>
          <LanguageToggle locale={locale} className={styles.languageToggle} />
          {/* 선택 기능인 설치 등록부는 아예 설정하지 않은 설치에서는 숨긴다.
              값을 넣었는데 틀린 설정 오류는 고칠 수 있도록 계속 보여 준다. */}
          {ownerRegistry && !ownerRegistry.unset && (
            <span
              className={styles.registryControl}
              title={ownerRegistry.error ?? undefined}
            >
              <span
                className={`${styles.registryLamp} ${ownerRegistry.enabled ? styles.registryLampOn : ""}`}
                aria-hidden="true"
              />
              {ownerRegistry.enabled ? (
                <button
                  type="button"
                  className={styles.registryButton}
                  disabled={ownerRegistryBusy}
                  onClick={() => void recordCurrentInstallation()}
                >
                  {ownerRegistryBusy ? t("등록 중…") : t("현재 설치 등록")}
                </button>
              ) : (
                <span className={styles.registryLabel}>
                  {ownerRegistry.error ?? t("등록부 확인 중")}
                </span>
              )}
            </span>
          )}
          <a href="/files" className={styles.headerLink}>
            <span aria-hidden="true">←</span>
            {t("파일로 돌아가기")}
          </a>
        </div>
      </header>

      <main className={styles.main}>
        {pending.length > 0 && (
          <p
            className={`${styles.message} ${styles.warningMessage}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className={styles.messageMark} aria-hidden="true">!</span>
            {t("초대 코드 입력을 기다리는 사용자가 {인원}명 있습니다.", {
              인원: pending.length,
            })}
          </p>
        )}
        {error && (
          <p
            className={`${styles.message} ${styles.errorMessage}`}
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <span className={styles.messageMark} aria-hidden="true">×</span>
            {error}
          </p>
        )}
        {notice && (
          <p
            className={`${styles.message} ${styles.noticeMessage}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className={styles.messageMark} aria-hidden="true">✓</span>
            {notice}
          </p>
        )}

        <section aria-labelledby="invite-title">
          <div className={styles.window}>
            <header className={styles.windowTitlebar}>
              <span className={styles.windowTitle}>
                <span className={styles.inviteGlyph} aria-hidden="true" />
                <h2 id="invite-title">{t("초대 코드")}</h2>
              </span>
              <span className={styles.windowMeta} aria-hidden="true">INVITES</span>
            </header>
            <div className={styles.windowBody}>
              <p id="invite-description" className={styles.description}>
                {t(
                  "받는 사람을 미리 지정하지 않습니다. Google 로그인 후 가입 대기 중인 사용자가 코드를 입력해 가입합니다. 1회용은 한 명이 가입하면 소진됩니다. 기간 내 무제한은 만료되거나 관리자가 끌 때까지 여러 명이 함께 씁니다.",
                )}
              </p>

              <form onSubmit={createInvite} className={styles.inviteForm}>
                <label className={styles.field}>
                  <span>{t("유효 기간")}</span>
                  <select
                    value={inviteForm.expiresInMinutes}
                    onChange={(event) =>
                      setInviteForm((current) => ({
                        ...current,
                        expiresInMinutes: Number(event.target.value),
                      }))
                    }
                    className={inputClass}
                  >
                    <option value={60}>{t("1시간")}</option>
                    <option value={1_440}>{t("24시간 (기본)")}</option>
                    <option value={10_080}>{t("7일")}</option>
                    <option value={43_200}>{t("30일")}</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t("사용 방식")}</span>
                  <select
                    value={inviteForm.usageMode}
                    onChange={(event) =>
                      setInviteForm((current) => ({
                        ...current,
                        usageMode: event.target.value as InvitationUsageMode,
                      }))
                    }
                    className={inputClass}
                  >
                    <option value="once">{t("1회용")}</option>
                    <option value="unlimited">{t("기간 내 무제한")}</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t("역할")}</span>
                  <select
                    value={inviteForm.role}
                    onChange={(event) =>
                      setInviteForm((current) => ({
                        ...current,
                        role: resolveUserRole(event.target.value),
                      }))
                    }
                    className={inputClass}
                  >
                    {USER_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(ROLE_LABELS[role])}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={busyId !== null}
                  className={`${styles.pixelButton} ${styles.primaryButton}`}
                >
                  {busyId === "invite:create" ? t("생성 중…") : t("초대 코드 생성")}
                </button>
              </form>

              {lastAccess && (
                <div className={styles.codePanel}>
                  <p className={styles.codeLabel}>{t("지금 전달할 초대 코드")}</p>
                  <div className={styles.codeRow}>
                    <input
                      readOnly
                      value={lastAccess.code}
                      onFocus={(event) => event.currentTarget.select()}
                      className={styles.codeInput}
                      aria-label={t("생성된 초대 코드")}
                    />
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() =>
                        void copyInvitationValue(lastAccess.code, lastAccess)
                      }
                      className={buttonClass}
                    >
                      {t("코드 복사")}
                    </button>
                  </div>
                </div>
              )}

              <div
                className={styles.tableRegion}
                role="region"
                aria-labelledby="invite-title"
                aria-describedby="invite-description"
                tabIndex={0}
              >
                <table className={`${styles.table} ${styles.inviteTable}`}>
                  <caption className={styles.srOnly}>
                    {t("초대 코드의 만료일, 사용 기록, 상태와 관리 작업")}
                  </caption>
                  <thead>
                    <tr className={styles.tableHeadRow}>
                      <th>{t("초대 코드")}</th>
                      <th>{t("만료일")}</th>
                      <th>{t("사용 방식")}</th>
                      <th>{t("사용 기록")}</th>
                      <th>{t("생성 정보")}</th>
                      <th>{t("상태")}</th>
                      <th><span className={styles.srOnly}>{t("관리 작업")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={7} className={styles.emptyCell}>
                          {t("불러오는 중…")}
                        </td>
                      </tr>
                    ) : invitations.length === 0 ? (
                      <tr>
                        <td colSpan={7} className={styles.emptyCell}>
                          {t("아직 만든 초대가 없습니다")}
                        </td>
                      </tr>
                    ) : (
                      invitations.map((invitation) => (
                        <tr key={invitation.id} className={styles.tableRow}>
                          <td className={styles.codeCell}>
                            {invitation.code ?? "—"}
                          </td>
                          <td className={styles.compactCell}>
                            <div>{formatDate(invitation.expiresAt, locale)}</div>
                            <div>
                              {formatDuration(invitation.durationMinutes, t)}
                            </div>
                          </td>
                          <td className={styles.compactCell}>
                            <div>{t(USAGE_MODE_LABEL[invitation.usageMode])}</div>
                            <div>
                              {t(ROLE_LABELS[resolveUserRole(invitation.role)])}
                            </div>
                          </td>
                          <td className={styles.compactCell}>
                            <div>
                              {t("{횟수}회", { 횟수: invitation.usageCount })}
                            </div>
                            {invitation.lastUsedAt && (
                              <div>
                                {invitation.lastUsedByEmail} · {formatDate(invitation.lastUsedAt, locale)}
                              </div>
                            )}
                          </td>
                          <td className={styles.compactCell}>
                            <div>{invitation.createdByEmail}</div>
                            <div>{formatDate(invitation.createdAt, locale)}</div>
                          </td>
                          <td>
                            <span className={`${styles.statusBadge} ${INVITE_STYLE[invitation.state]}`}>
                              {t(INVITE_LABEL[invitation.state])}
                            </span>
                          </td>
                          <td className={styles.actionsCell}>
                            {invitation.state !== "used" && (
                              <span className={styles.rowActions}>
                                {invitation.state === "active" && invitation.code && (
                                  <button
                                    type="button"
                                    disabled={busyId !== null}
                                    onClick={() =>
                                      void copyInvitationValue(invitation.code!, {
                                        invitationId: invitation.id,
                                        code: invitation.code!,
                                      })
                                    }
                                    className={buttonClass}
                                  >
                                    {t("코드 복사")}
                                  </button>
                                )}
                                {invitation.state !== "expired" && (
                                  <button
                                    type="button"
                                    disabled={busyId !== null}
                                    onClick={() =>
                                      void invitationAction(invitation, "toggle")
                                    }
                                    className={buttonClass}
                                  >
                                    {invitation.state === "active"
                                      ? t("비활성")
                                      : t("활성")}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={busyId !== null}
                                  onClick={() =>
                                    void invitationAction(invitation, "rotate")
                                  }
                                  className={buttonClass}
                                >
                                  {t("새 코드")}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="user-title">
          <div className={styles.window}>
            <header className={`${styles.windowTitlebar} ${styles.userTitlebar}`}>
              <span className={styles.windowTitle}>
                <span className={styles.userGlyph} aria-hidden="true" />
                <h2 id="user-title">{t("사용자")}</h2>
              </span>
              <span className={styles.windowMeta} aria-hidden="true">
                {users.length.toString().padStart(2, "0")} USERS
              </span>
            </header>
            <div className={styles.windowBody}>
              <div
                className={styles.tableRegion}
                role="region"
                aria-labelledby="user-title"
                tabIndex={0}
              >
                <table className={`${styles.table} ${styles.userTable}`}>
                  <caption className={styles.srOnly}>
                    {t("사용자 등록일, 상태, 역할, 로그인 기기와 관리 작업")}
                  </caption>
                  <thead>
                    <tr className={styles.tableHeadRow}>
                      <th>{t("사용자")}</th>
                      <th>{t("등록일")}</th>
                      <th>{t("상태")}</th>
                      <th>{t("역할")}</th>
                      <th>{t("로그인 기기")}</th>
                      <th><span className={styles.srOnly}>{t("관리 작업")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={6} className={styles.emptyCell}>
                          {t("불러오는 중…")}
                        </td>
                      </tr>
                    ) : users.length === 0 ? (
                      <tr>
                        <td colSpan={6} className={styles.emptyCell}>
                          {t("아직 등록된 사용자가 없습니다")}
                        </td>
                      </tr>
                    ) : (
                      users.map((user) => (
                        <tr key={user.id} className={styles.tableRow}>
                          <td>
                            <div className={styles.userName}>
                              {user.name}
                              {user.isAdmin && (
                                <span className={styles.adminBadge}>
                                  {t("관리자")}
                                </span>
                              )}
                            </div>
                            <div className={styles.userEmail}>{user.email}</div>
                          </td>
                          <td className={styles.compactCell}>
                            {formatDate(user.createdAt, locale)}
                          </td>
                          <td>
                            <span className={`${styles.statusBadge} ${STATUS_STYLE[user.status]}`}>
                              {t(STATUS_LABEL[user.status])}
                            </span>
                          </td>
                          <td>
                            {user.isAdmin ? (
                              <span className={styles.muted}>{t("관리자")}</span>
                            ) : (
                              <select
                                value={resolveUserRole(user.role)}
                                disabled={busyId !== null}
                                onChange={(event) =>
                                  void changeRole(
                                    user.id,
                                    resolveUserRole(event.target.value),
                                  )
                                }
                                className={`${styles.select} ${styles.roleSelect}`}
                                aria-label={t("{이름} 역할 변경", {
                                  이름: user.name,
                                })}
                              >
                                {USER_ROLES.map((role) => (
                                  <option key={role} value={role}>
                                    {t(ROLE_LABELS[role])}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td>
                            {user.sessions.length === 0 ? (
                              <span className={styles.muted}>{t("기록 없음")}</span>
                            ) : (
                              <ul className={styles.sessionList}>
                                {[...user.sessions].reverse().map((session) => (
                                  <li key={session.id} className={styles.sessionRow}>
                                    <span className={styles.sessionInfo}>
                                      <span className={styles.sessionDevice}>
                                        {session.deviceLabel}
                                      </span>
                                      <span className={styles.sessionDate}>
                                        {formatDate(session.createdAt, locale)}
                                      </span>
                                    </span>
                                    {!user.isAdmin ? (
                                      <button
                                        disabled={busyId !== null}
                                        onClick={() =>
                                          void act(user.id, "revoke-session", session.id)
                                        }
                                        className={`${styles.pixelButton} ${styles.dangerButton}`}
                                      >
                                        {t("이 로그인 끊기")}
                                      </button>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className={styles.actionsCell}>
                            {user.isAdmin ? (
                              <span className={styles.muted}>—</span>
                            ) : confirmRemoveId === user.id ? (
                              <span className={styles.rowActions}>
                                <button
                                  disabled={busyId !== null}
                                  onClick={() => void act(user.id, "remove")}
                                  className={`${styles.pixelButton} ${styles.dangerButton}`}
                                >
                                  {t("삭제 확인")}
                                </button>
                                <button
                                  onClick={() => setConfirmRemoveId(null)}
                                  className={buttonClass}
                                >
                                  {t("취소")}
                                </button>
                              </span>
                            ) : (
                              <span className={styles.rowActions}>
                                {user.status === "approved" && (
                                  <>
                                    <button
                                      disabled={busyId !== null}
                                      onClick={() => void act(user.id, "revoke")}
                                      className={buttonClass}
                                      title={t(
                                        "이 사람의 모든 기기에서 로그인을 끊습니다",
                                      )}
                                    >
                                      {t("모든 로그인 끊기")}
                                    </button>
                                    <button
                                      disabled={busyId !== null}
                                      onClick={() => void act(user.id, "block")}
                                      className={buttonClass}
                                    >
                                      {t("차단")}
                                    </button>
                                  </>
                                )}
                                {user.status === "blocked" && (
                                  <button
                                    disabled={busyId !== null}
                                    onClick={() => void act(user.id, "pending")}
                                    className={buttonClass}
                                  >
                                    {t("대기로")}
                                  </button>
                                )}
                                <button
                                  onClick={() => setConfirmRemoveId(user.id)}
                                  className={buttonClass}
                                >
                                  {t("삭제")}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <ul className={styles.helpList}>
                <li>
                  {t(
                    "차단하면 화면 접근은 즉시 막히고, 열려 있던 파일 목록도 최대 5초 안에 끊깁니다.",
                  )}
                </li>
                <li>
                  {t(
                    "차단·모든 로그인 끊기를 하면 기존 로그인이 전부 무효가 되어, 다시 가입 대기로 바꾼 뒤에도 새로 로그인하고 초대 코드를 입력해야 합니다.",
                  )}
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
