"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@/lib/users";

type InvitationState = "active" | "inactive" | "used";

interface InvitationSummary {
  id: string;
  recipientName: string;
  email: string;
  note: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  createdByEmail: string;
  usedAt: string | null;
  usedByUserId: string | null;
  usedByEmail: string | null;
  state: InvitationState;
  link: string | null;
}

type InvitationEdit = Pick<
  InvitationSummary,
  "id" | "recipientName" | "email" | "note"
>;

type LastInvitationLink = {
  invitationId: string;
  link: string;
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STATUS_LABEL: Record<User["status"], string> = {
  pending: "승인 대기",
  approved: "승인됨",
  blocked: "차단됨",
};

const STATUS_STYLE: Record<User["status"], string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  approved:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
};

const INVITE_LABEL: Record<InvitationState, string> = {
  active: "사용 가능",
  inactive: "비활성",
  used: "사용 완료",
};

const INVITE_STYLE: Record<InvitationState, string> = {
  active:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  inactive: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  used: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

export default function AdminView() {
  const router = useRouter();
  const editDialogRef = useRef<HTMLElement>(null);
  const editOpenerRef = useRef<HTMLElement | null>(null);
  const mutationInFlightRef = useRef(false);
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [lastLink, setLastLink] = useState<LastInvitationLink | null>(null);
  const [editingInvite, setEditingInvite] = useState<InvitationEdit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({
    recipientName: "",
    email: "",
    note: "",
    active: true,
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
        throw new Error(userBody?.error ?? "사용자 목록을 불러오지 못했습니다");
      }
      if (!inviteResponse.ok) {
        throw new Error(inviteBody?.error ?? "초대 목록을 불러오지 못했습니다");
      }
      setUsers(userBody.users);
      setInvitations(inviteBody.invitations);
      setLastLink((current) => {
        if (!current) return null;
        const invitation = inviteBody.invitations.find(
          (item: InvitationSummary) => item.id === current.invitationId,
        );
        return invitation?.state === "active" && invitation.link
          ? { invitationId: invitation.id, link: invitation.link }
          : null;
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "관리 정보를 불러오지 못했습니다",
      );
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  const editDialogOpen = editingInvite !== null;
  useEffect(() => {
    if (!editDialogOpen) return;
    const frame = window.requestAnimationFrame(() => {
      editDialogRef.current
        ?.querySelector<HTMLElement>("[data-initial-focus]")
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const opener = editOpenerRef.current;
      editOpenerRef.current = null;
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [editDialogOpen]);

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
      if (!response.ok) throw new Error(body?.error ?? "처리하지 못했습니다");
      if (body?.warning) setNotice(body.warning);
      else if (action === "revoke-session") {
        setNotice("선택한 로그인을 끊었습니다");
      }
      setConfirmRemoveId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "처리하지 못했습니다");
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
        throw new Error(body?.error ?? "초대 링크를 만들지 못했습니다");
      }
      setLastLink(
        body.invitation.state === "active" && body.invitation.link
          ? {
              invitationId: body.invitation.id,
              link: body.invitation.link,
            }
          : null,
      );
      setInviteForm({ recipientName: "", email: "", note: "", active: true });
      setNotice("초대 링크를 만들었습니다. 아래 링크를 전달해 주세요.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "초대 링크를 만들지 못했습니다",
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
                active: !invitation.active,
              },
        ),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "초대를 바꾸지 못했습니다");
      if (action === "rotate") {
        setLastLink({
          invitationId: body.invitation.id,
          link: body.invitation.link,
        });
        setNotice("예전 링크를 무효화하고 새 링크를 만들었습니다.");
      } else if (body.invitation.state === "active" && body.invitation.link) {
        setLastLink({
          invitationId: body.invitation.id,
          link: body.invitation.link,
        });
      } else {
        setLastLink((current) =>
          current?.invitationId === invitation.id ? null : current,
        );
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "초대를 바꾸지 못했습니다");
    } finally {
      finishMutation();
    }
  }

  function beginInvitationEdit(
    invitation: InvitationSummary,
    opener: HTMLElement,
  ) {
    editOpenerRef.current = opener;
    setEditError(null);
    setEditingInvite({
      id: invitation.id,
      recipientName: invitation.recipientName,
      email: invitation.email,
      note: invitation.note,
    });
  }

  function closeInvitationEdit() {
    if (editingInvite && busyId === null) {
      setEditingInvite(null);
      setEditError(null);
    }
  }

  async function saveInvitationEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingInvite) return;
    const previousInvitation = invitations.find(
      (invitation) => invitation.id === editingInvite.id,
    );
    const busyKey = `invite:${editingInvite.id}`;
    if (!beginMutation(busyKey)) return;
    setEditError(null);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingInvite.id,
          action: "update",
          recipientName: editingInvite.recipientName,
          email: editingInvite.email,
          note: editingInvite.note,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "초대 정보를 저장하지 못했습니다");
      }
      if (body.invitation.state === "active" && body.invitation.link) {
        setLastLink((current) =>
          !previousInvitation ||
          previousInvitation.link !== body.invitation.link ||
          current?.invitationId === editingInvite.id
            ? {
                invitationId: body.invitation.id,
                link: body.invitation.link,
              }
            : current,
        );
      } else {
        setLastLink((current) =>
          current?.invitationId === editingInvite.id ? null : current,
        );
      }
      setEditingInvite(null);
      setNotice("초대 정보를 저장했습니다.");
      await load();
    } catch (caught) {
      setEditError(
        caught instanceof Error
          ? caught.message
          : "초대 정보를 저장하지 못했습니다",
      );
    } finally {
      finishMutation();
    }
  }

  function handleEditDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!editingInvite) return;
    const isBusy = busyId !== null;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!isBusy) closeInvitationEdit();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !event.currentTarget.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  async function copyLink(link: string, invitationId: string) {
    if (mutationInFlightRef.current) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("초대 링크를 복사했습니다.");
    } catch {
      setLastLink({ invitationId, link });
      setNotice("아래 링크를 직접 선택해 복사해 주세요.");
    }
  }

  const buttonClass =
    "whitespace-nowrap rounded px-2 py-1 text-xs text-zinc-600 hover:bg-black/5 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-white/10";
  const inputClass =
    "w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15";
  const pending = users.filter((user) => user.status === "pending");

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/15">
        <h1 className="text-lg font-semibold tracking-tight">사용자 및 초대 관리</h1>
        <a
          href="/files"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          파일로 돌아가기
        </a>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-6 py-6">
        {pending.length > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            기존 승인 대기 사용자가 {pending.length}명 있습니다.
          </p>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {notice && (
          <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            {notice}
          </p>
        )}

        <section aria-labelledby="invite-title">
          <div className="mb-3">
            <h2 id="invite-title" className="text-base font-semibold">
              초대 링크
            </h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              지정한 Google 이메일에서 한 번만 사용할 수 있습니다.
            </p>
          </div>

          <form
            onSubmit={createInvite}
            className="grid gap-3 rounded-xl border border-black/10 p-4 md:grid-cols-2 dark:border-white/15"
          >
            <label className="space-y-1 text-xs text-zinc-500">
              <span>이름</span>
              <input
                required
                maxLength={100}
                value={inviteForm.recipientName}
                onChange={(event) =>
                  setInviteForm((current) => ({
                    ...current,
                    recipientName: event.target.value,
                  }))
                }
                className={inputClass}
                placeholder="초대받을 사람 이름"
              />
            </label>
            <label className="space-y-1 text-xs text-zinc-500">
              <span>Google 이메일</span>
              <input
                required
                type="email"
                maxLength={320}
                value={inviteForm.email}
                onChange={(event) =>
                  setInviteForm((current) => ({
                    ...current,
                    email: event.target.value,
                  }))
                }
                className={inputClass}
                placeholder="name@gmail.com"
              />
            </label>
            <label className="space-y-1 text-xs text-zinc-500 md:col-span-2">
              <span>비고</span>
              <textarea
                maxLength={500}
                rows={2}
                value={inviteForm.note}
                onChange={(event) =>
                  setInviteForm((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
                className={inputClass}
                placeholder="소속, 용도 등 관리 메모"
              />
            </label>
            <div className="flex items-center justify-between md:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={inviteForm.active}
                  onChange={(event) =>
                    setInviteForm((current) => ({
                      ...current,
                      active: event.target.checked,
                    }))
                  }
                />
                생성 즉시 활성화
              </label>
              <button
                type="submit"
                disabled={busyId !== null}
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
              >
                {busyId === "invite:create" ? "생성 중…" : "초대 링크 생성"}
              </button>
            </div>
          </form>

          {lastLink && (
            <div className="mt-3 flex gap-2 rounded-lg bg-black/5 p-3 dark:bg-white/5">
              <input
                readOnly
                value={lastLink.link}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                aria-label="생성된 초대 링크"
              />
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() =>
                  void copyLink(lastLink.link, lastLink.invitationId)
                }
                className={buttonClass}
              >
                복사
              </button>
            </div>
          )}

          <div className="mt-4 overflow-x-auto rounded-xl border border-black/10 dark:border-white/15">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15 dark:text-zinc-400">
                  <th className="px-4 py-2.5 font-medium">대상</th>
                  <th className="px-4 py-2.5 font-medium">생성일</th>
                  <th className="px-4 py-2.5 font-medium">비고</th>
                  <th className="px-4 py-2.5 font-medium">상태</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-400">
                      불러오는 중…
                    </td>
                  </tr>
                ) : invitations.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-400">
                      아직 만든 초대가 없습니다
                    </td>
                  </tr>
                ) : (
                  invitations.map((invitation) => (
                    <tr
                      key={invitation.id}
                      className="border-b border-black/5 last:border-b-0 dark:border-white/5"
                    >
                      <td className="px-4 py-2">
                        <div className="font-medium">{invitation.recipientName}</div>
                        <div className="text-xs text-zinc-500">{invitation.email}</div>
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">
                        {formatDate(invitation.createdAt)}
                      </td>
                      <td className="max-w-64 whitespace-pre-wrap px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300">
                        {invitation.note || "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${INVITE_STYLE[invitation.state]}`}
                        >
                          {INVITE_LABEL[invitation.state]}
                        </span>
                        {invitation.usedAt && (
                          <div className="mt-1 text-xs text-zinc-500">
                            {invitation.usedByEmail} · {formatDate(invitation.usedAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {invitation.state !== "used" && (
                          <span className="flex items-center justify-end gap-1">
                            {invitation.state === "active" && invitation.link && (
                              <button
                                type="button"
                                disabled={busyId !== null}
                                onClick={() =>
                                  void copyLink(invitation.link!, invitation.id)
                                }
                                className={buttonClass}
                              >
                                링크 복사
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={(event) =>
                                beginInvitationEdit(
                                  invitation,
                                  event.currentTarget,
                                )
                              }
                              className={buttonClass}
                            >
                              정보 수정
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() =>
                                void invitationAction(invitation, "toggle")
                              }
                              className={buttonClass}
                            >
                              {invitation.active ? "비활성" : "활성"}
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() =>
                                void invitationAction(invitation, "rotate")
                              }
                              className={buttonClass}
                            >
                              새 링크
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
        </section>

        {editingInvite && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeInvitationEdit();
            }}
          >
            <section
              ref={editDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="invite-edit-title"
              aria-describedby={editError ? "invite-edit-error" : undefined}
              onKeyDown={handleEditDialogKeyDown}
              className="w-full max-w-xl rounded-xl bg-background p-5 shadow-2xl ring-1 ring-black/10 dark:ring-white/15"
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 id="invite-edit-title" className="text-base font-semibold">
                  초대 정보 수정
                </h2>
                <button
                  type="button"
                  aria-label="닫기"
                  disabled={busyId !== null}
                  onClick={closeInvitationEdit}
                  className={buttonClass}
                >
                  닫기
                </button>
              </div>
              <form
                onSubmit={saveInvitationEdit}
                className="grid gap-3 sm:grid-cols-2"
              >
                <label className="space-y-1 text-xs text-zinc-500">
                  <span>이름</span>
                  <input
                    data-initial-focus
                    required
                    maxLength={100}
                    value={editingInvite.recipientName}
                    onChange={(event) =>
                      setEditingInvite((current) =>
                        current
                          ? { ...current, recipientName: event.target.value }
                          : current,
                      )
                    }
                    className={inputClass}
                  />
                </label>
                <label className="space-y-1 text-xs text-zinc-500">
                  <span>Google 이메일</span>
                  <input
                    required
                    type="email"
                    maxLength={320}
                    value={editingInvite.email}
                    onChange={(event) =>
                      setEditingInvite((current) =>
                        current
                          ? { ...current, email: event.target.value }
                          : current,
                      )
                    }
                    className={inputClass}
                  />
                </label>
                <label className="space-y-1 text-xs text-zinc-500 sm:col-span-2">
                  <span>비고</span>
                  <textarea
                    maxLength={500}
                    rows={4}
                    value={editingInvite.note}
                    onChange={(event) =>
                      setEditingInvite((current) =>
                        current
                          ? { ...current, note: event.target.value }
                          : current,
                      )
                    }
                    className={inputClass}
                  />
                </label>
                {editError && (
                  <p
                    id="invite-edit-error"
                    role="alert"
                    className="text-sm text-red-600 sm:col-span-2 dark:text-red-400"
                  >
                    {editError}
                  </p>
                )}
                <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={closeInvitationEdit}
                    className="rounded-lg border border-black/10 px-4 py-2 text-sm disabled:opacity-40 dark:border-white/15"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    disabled={busyId !== null}
                    className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
                  >
                    {busyId === `invite:${editingInvite.id}` ? "저장 중…" : "저장"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}

        <section aria-labelledby="user-title">
          <h2 id="user-title" className="mb-3 text-base font-semibold">
            사용자
          </h2>
          <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/15">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15 dark:text-zinc-400">
                  <th className="px-4 py-2.5 font-medium">사용자</th>
                  <th className="px-4 py-2.5 font-medium">등록일</th>
                  <th className="w-24 px-4 py-2.5 font-medium">상태</th>
                  <th className="min-w-56 px-4 py-2.5 font-medium">
                    로그인 기기
                  </th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-400">
                      불러오는 중…
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-400">
                      아직 등록된 사용자가 없습니다
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-black/5 last:border-b-0 dark:border-white/5"
                    >
                      <td className="px-4 py-2">
                        <div className="font-medium">
                          {user.name}
                          {user.isAdmin && (
                            <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-xs font-normal text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                              관리자
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {user.email}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[user.status]}`}
                        >
                          {STATUS_LABEL[user.status]}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {user.sessions.length === 0 ? (
                          <span className="text-xs text-zinc-400">기록 없음</span>
                        ) : (
                          <ul className="space-y-1.5">
                            {[...user.sessions].reverse().map((session) => (
                              <li
                                key={session.id}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-xs font-medium">
                                    {session.deviceLabel}
                                  </span>
                                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                                    {formatDate(session.createdAt)}
                                  </span>
                                </span>
                                {!user.isAdmin ? (
                                  <button
                                    disabled={busyId !== null}
                                    onClick={() =>
                                      void act(
                                        user.id,
                                        "revoke-session",
                                        session.id,
                                      )
                                    }
                                    className="shrink-0 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-950/30"
                                  >
                                    이 로그인 끊기
                                  </button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {user.isAdmin ? (
                          <span className="text-xs text-zinc-400">—</span>
                        ) : confirmRemoveId === user.id ? (
                          <span className="flex items-center justify-end gap-1">
                            <button
                              disabled={busyId !== null}
                              onClick={() => void act(user.id, "remove")}
                              className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                            >
                              삭제 확인
                            </button>
                            <button
                              onClick={() => setConfirmRemoveId(null)}
                              className={buttonClass}
                            >
                              취소
                            </button>
                          </span>
                        ) : (
                          <span className="flex items-center justify-end gap-1">
                            {user.status !== "approved" && (
                              <button
                                disabled={busyId !== null}
                                onClick={() => void act(user.id, "approve")}
                                className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                              >
                                승인
                              </button>
                            )}
                            {user.status === "approved" && (
                              <>
                                <button
                                  disabled={busyId !== null}
                                  onClick={() => void act(user.id, "revoke")}
                                  className={buttonClass}
                                  title="이 사람의 모든 기기에서 로그인을 끊습니다"
                                >
                                  모든 로그인 끊기
                                </button>
                                <button
                                  disabled={busyId !== null}
                                  onClick={() => void act(user.id, "block")}
                                  className={buttonClass}
                                >
                                  차단
                                </button>
                              </>
                            )}
                            {user.status === "blocked" && (
                              <button
                                disabled={busyId !== null}
                                onClick={() => void act(user.id, "pending")}
                                className={buttonClass}
                              >
                                대기로
                              </button>
                            )}
                            <button
                              onClick={() => setConfirmRemoveId(user.id)}
                              className={buttonClass}
                            >
                              삭제
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
          <ul className="mt-4 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <li>
              차단하면 화면 접근은 즉시 막히고, 열려 있던 파일 목록도 최대 5초 안에
              끊깁니다.
            </li>
            <li>
              차단·모든 로그인 끊기를 하면 기존 로그인이 전부 무효가 되어, 다시
              승인해도 새로 로그인해야 합니다.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
