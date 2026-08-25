"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import { ROLE_LABELS, USER_ROLES, type UserRole } from "@/lib/roles";
import type { AccessibleSpace } from "@/lib/space-access";
import LogoutButton from "../LogoutButton";

// 데스크 목록 화면(#12). 기본 데스크와 들어갈 수 있는 스페이스를 나열하고,
// 관리자에게는 멀티 데스크 관리(생성·이름 변경·등록 해제·멤버 명단)를 겸한다.
// 스페이스 멤버십은 기본 데스크의 승인된 사용자를 관리자가 명단에 넣는
// 방식이다 — 가입 자체는 언제나 기본 데스크에서만 일어난다.

interface SpaceMember {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
}

interface BaseUser {
  id: string;
  email: string;
  name: string;
  status: string;
}

const CARD_CLASS =
  "rounded-2xl border border-black/10 shadow-sm dark:border-white/15";

export default function SpacesView({
  locale,
  spaces,
  canManage,
  userName,
}: {
  locale: Locale;
  spaces: AccessibleSpace[];
  canManage: boolean;
  userName: string;
}) {
  const router = useRouter();
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      translate(locale, text, vars),
    [locale],
  );

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apiJson = useCallback(
    async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
      // 이 화면은 /spaces(기본 문맥)에서만 렌더되고 관리 API는 기본 데스크
      // 등록부를 대상으로 하므로 스페이스 프리픽스를 붙이지 않는다.
      const response = await fetch(path, {
        cache: "no-store",
        ...init,
      });
      if (response.status === 401) {
        router.replace("/");
        throw new Error(t("세션이 만료되었습니다"));
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? t(body.error)
            : t("요청에 실패했습니다"),
        );
      }
      return body as T;
    },
    [router, t],
  );

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : t("요청에 실패했습니다"),
        );
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <main className="relative flex flex-1 items-start justify-center p-6">
      <div className="w-full max-w-lg pb-16">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {t("데스크 목록")}
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {t("들어갈 데스크를 고르세요.")}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">{userName}</span>
            <LogoutButton locale={locale} />
          </div>
        </header>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <ul className="mt-6 flex flex-col gap-3">
          <li>
            <DeskLink
              href="/files"
              name={t("기본 데스크")}
              address="/files"
              enterLabel={t("입장")}
            />
          </li>
          {spaces.map((space) => (
            <li key={space.slug} className={canManage ? CARD_CLASS : undefined}>
              <DeskLink
                href={`/${space.slug}/files`}
                name={space.name}
                address={`/${space.slug}`}
                enterLabel={t("입장")}
                bare={canManage}
              />
              {canManage && (
                <SpaceAdminRow
                  space={space}
                  t={t}
                  busy={busy}
                  run={run}
                  apiJson={apiJson}
                  onChanged={() => router.refresh()}
                />
              )}
            </li>
          ))}
        </ul>
        {spaces.length === 0 && (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            {t("아직 들어갈 수 있는 스페이스가 없습니다.")}
          </p>
        )}

        {canManage && (
          <CreateSpaceForm
            t={t}
            busy={busy}
            run={run}
            apiJson={apiJson}
            onCreated={() => router.refresh()}
          />
        )}
      </div>
    </main>
  );
}

function DeskLink({
  href,
  name,
  address,
  enterLabel,
  bare = false,
}: {
  href: string;
  name: string;
  address: string;
  enterLabel: string;
  bare?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between px-5 py-4 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
        bare ? "rounded-t-2xl" : CARD_CLASS
      }`}
    >
      <span>
        <span className="block font-medium">{name}</span>
        <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
          {address}
        </span>
      </span>
      <span className="shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
        {enterLabel} →
      </span>
    </Link>
  );
}

type Translator = (text: string, vars?: Record<string, string | number>) => string;
type ApiJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type Run = (action: () => Promise<void>) => Promise<void>;

// 스페이스 한 줄의 관리 도구: 이름 바꾸기 · 멤버 명단 · 등록 해제.
function SpaceAdminRow({
  space,
  t,
  busy,
  run,
  apiJson,
  onChanged,
}: {
  space: AccessibleSpace;
  t: Translator;
  busy: boolean;
  run: Run;
  apiJson: ApiJson;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(space.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  async function rename() {
    await run(async () => {
      await apiJson(`/api/spaces/${encodeURIComponent(space.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameValue }),
      });
      setRenaming(false);
      onChanged();
    });
  }

  async function removeRegistration() {
    await run(async () => {
      await apiJson(`/api/spaces/${encodeURIComponent(space.slug)}`, {
        method: "DELETE",
      });
      setConfirmingDelete(false);
      onChanged();
    });
  }

  return (
    <div className="border-t border-black/10 px-5 py-3 text-sm dark:border-white/15">
      <div className="flex flex-wrap items-center gap-3">
        {renaming ? (
          <>
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={40}
              className="min-w-0 flex-1 rounded-lg border border-black/15 bg-transparent px-2 py-1 outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
              aria-label={t("이름")}
            />
            <button
              type="button"
              disabled={busy || !renameValue.trim()}
              onClick={() => void rename()}
              className="font-medium disabled:opacity-40"
            >
              {t("저장")}
            </button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false);
                setRenameValue(space.name);
              }}
            >
              {t("취소")}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setRenaming(true)}>
              {t("이름 바꾸기")}
            </button>
            <button
              type="button"
              aria-expanded={membersOpen}
              onClick={() => setMembersOpen((current) => !current)}
            >
              {t("멤버 관리")}
            </button>
            {confirmingDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-red-600 dark:text-red-400">
                  {t("정말 해제할까요?")}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeRegistration()}
                  className="font-medium text-red-600 disabled:opacity-40 dark:text-red-400"
                >
                  {t("등록 해제")}
                </button>
                <button type="button" onClick={() => setConfirmingDelete(false)}>
                  {t("취소")}
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-red-600 dark:text-red-400"
              >
                {t("등록 해제")}
              </button>
            )}
          </>
        )}
      </div>
      {confirmingDelete && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {t("등록만 해제하며 파일은 저장소에 남습니다.")}
        </p>
      )}
      {membersOpen && (
        <SpaceMembersPanel
          slug={space.slug}
          t={t}
          busy={busy}
          run={run}
          apiJson={apiJson}
        />
      )}
    </div>
  );
}

// 스페이스 멤버 명단. 기본 데스크의 승인된 사용자만 후보로 보여 준다.
function SpaceMembersPanel({
  slug,
  t,
  busy,
  run,
  apiJson,
}: {
  slug: string;
  t: Translator;
  busy: boolean;
  run: Run;
  apiJson: ApiJson;
}) {
  const [members, setMembers] = useState<SpaceMember[] | null>(null);
  const [candidates, setCandidates] = useState<BaseUser[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<UserRole>("viewer");

  const reload = useCallback(async () => {
    const [memberBody, userBody] = await Promise.all([
      apiJson<{ members: SpaceMember[] }>(
        `/api/spaces/${encodeURIComponent(slug)}/members`,
      ),
      apiJson<{ users: BaseUser[] }>("/api/admin/users"),
    ]);
    setMembers(memberBody.members);
    setCandidates(userBody.users.filter((user) => user.status === "approved"));
  }, [apiJson, slug]);

  useEffect(() => {
    void run(reload);
  }, [run, reload]);

  if (members === null) {
    return (
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {t("불러오는 중…")}
      </p>
    );
  }

  const memberIds = new Set(members.map((member) => member.id));
  const addable = candidates.filter((user) => !memberIds.has(user.id));

  return (
    <div className="mt-3 flex flex-col gap-2">
      {members.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {t("구성원이 없습니다.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-black/5 px-3 py-1.5 dark:bg-white/5"
            >
              <span className="min-w-0">
                <span className="block truncate">{member.name}</span>
                <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {member.email} ·{" "}
                  {t(ROLE_LABELS[member.role as UserRole] ?? member.role)}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                className="shrink-0 text-red-600 disabled:opacity-40 dark:text-red-400"
                onClick={() =>
                  void run(async () => {
                    await apiJson(
                      `/api/spaces/${encodeURIComponent(slug)}/members?userId=${encodeURIComponent(member.id)}`,
                      { method: "DELETE" },
                    );
                    await reload();
                  })
                }
              >
                {t("제거")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={addUserId}
          onChange={(event) => setAddUserId(event.target.value)}
          aria-label={t("멤버 추가")}
          className="min-w-0 flex-1 rounded-lg border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
        >
          <option value="">{t("멤버 추가")}…</option>
          {addable.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.email})
            </option>
          ))}
        </select>
        <select
          value={addRole}
          onChange={(event) => setAddRole(event.target.value as UserRole)}
          aria-label={t("역할")}
          className="rounded-lg border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
        >
          {USER_ROLES.map((role) => (
            <option key={role} value={role}>
              {t(ROLE_LABELS[role])}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !addUserId}
          className="font-medium disabled:opacity-40"
          onClick={() =>
            void run(async () => {
              await apiJson(`/api/spaces/${encodeURIComponent(slug)}/members`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: addUserId, role: addRole }),
              });
              setAddUserId("");
              await reload();
            })
          }
        >
          {t("추가")}
        </button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {t("기본 데스크의 승인된 사용자만 추가할 수 있습니다.")}
      </p>
    </div>
  );
}

// 새 스페이스 만들기 — 저장소에 .spaces/<주소> 폴더가 생기고 등록부에 오른다.
function CreateSpaceForm({
  t,
  busy,
  run,
  apiJson,
  onCreated,
}: {
  t: Translator;
  busy: boolean;
  run: Run;
  apiJson: ApiJson;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  return (
    <section className={`mt-8 ${CARD_CLASS} p-5`}>
      <h2 className="font-semibold">{t("스페이스 관리")}</h2>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await apiJson("/api/spaces", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slug, name }),
            });
            setSlug("");
            setName("");
            onCreated();
          });
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("주소")}</span>
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="sea"
            maxLength={32}
            className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("이름")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            className="rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !slug.trim() || !name.trim()}
          className="rounded-lg border border-black/15 py-2 font-medium transition-opacity disabled:opacity-40 dark:border-white/20"
        >
          {t("만들기")}
        </button>
      </form>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {t("주소는 영문 소문자·숫자·하이픈 1~32자입니다.")}
      </p>
    </section>
  );
}
