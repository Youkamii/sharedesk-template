"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { translate, type Locale } from "@/lib/i18n";
import { ROLE_LABELS, USER_ROLES, type UserRole } from "@/lib/roles";
import type { AccessibleSpace } from "@/lib/space-access";
import LogoutButton from "../LogoutButton";
import styles from "./spaces.module.css";

// 데스크 선택 화면(#12·#14) — 로그인 다음의 "전 단계". main(기본 데스크)과
// 들어갈 수 있는 스페이스를 나열하고, 관리자에게는 스페이스 관리(생성·이름
// 변경·등록 해제·멤버 명단)를 겸한다. 로그아웃도 여기 있다 — 데스크 안
// 트레이의 [나가기]가 이 화면으로 돌아온다. 스페이스 멤버십은 기본 데스크의
// 승인된 사용자를 관리자가 명단에 넣는 방식이다.

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
    <main className={styles.screen}>
      <div className={styles.window}>
        <header className={styles.titlebar}>
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <strong>ShareDesk</strong>
          <span>{t("데스크 목록")}</span>
          <span className={styles.userTag} title={userName}>
            {userName}
          </span>
        </header>
        <div className={styles.body}>
          <p className={styles.lead}>{t("들어갈 데스크를 고르세요.")}</p>

          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}

          <ul className={styles.deskList}>
            <li className={styles.deskCard}>
              {/* 기본 데스크는 main이라는 이름의 데스크로 함께 선다(#14). */}
              <DeskLink
                href="/files"
                name="main"
                address="/files"
                enterLabel={t("입장")}
              />
            </li>
            {spaces.map((space) => (
              <li key={space.slug} className={styles.deskCard}>
                <DeskLink
                  href={`/${space.slug}/files`}
                  name={space.name}
                  address={`/${space.slug}`}
                  enterLabel={t("입장")}
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

          {canManage && (
            <CreateSpaceForm
              t={t}
              busy={busy}
              run={run}
              apiJson={apiJson}
              onCreated={() => router.refresh()}
            />
          )}

          <div className={styles.footerRow}>
            <LogoutButton locale={locale} className={styles.pixelButton} />
          </div>
        </div>
      </div>
    </main>
  );
}

function DeskLink({
  href,
  name,
  address,
  enterLabel,
}: {
  href: string;
  name: string;
  address: string;
  enterLabel: string;
}) {
  return (
    <Link href={href} className={styles.deskLink}>
      <span>
        <span className={styles.deskName}>{name}</span>
        <span className={styles.deskAddress}>{address}</span>
      </span>
      <span className={styles.enter}>{enterLabel} →</span>
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
    <>
      <div className={styles.adminRow}>
        {renaming ? (
          <>
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={40}
              className={styles.input}
              aria-label={t("이름")}
            />
            <button
              type="button"
              className={styles.pixelButton}
              disabled={busy || !renameValue.trim()}
              onClick={() => void rename()}
            >
              {t("저장")}
            </button>
            <button
              type="button"
              className={styles.pixelButton}
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
            <button
              type="button"
              className={styles.pixelButton}
              onClick={() => setRenaming(true)}
            >
              {t("이름 바꾸기")}
            </button>
            <button
              type="button"
              className={styles.pixelButton}
              aria-expanded={membersOpen}
              onClick={() => setMembersOpen((current) => !current)}
            >
              {t("멤버 관리")}
            </button>
            {confirmingDelete ? (
              <>
                <span className={styles.confirmText}>
                  {t("정말 해제할까요?")}
                </span>
                <button
                  type="button"
                  className={`${styles.pixelButton} ${styles.dangerButton}`}
                  disabled={busy}
                  onClick={() => void removeRegistration()}
                >
                  {t("등록 해제")}
                </button>
                <button
                  type="button"
                  className={styles.pixelButton}
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t("취소")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={`${styles.pixelButton} ${styles.dangerButton}`}
                onClick={() => setConfirmingDelete(true)}
              >
                {t("등록 해제")}
              </button>
            )}
          </>
        )}
      </div>
      {confirmingDelete && (
        <div className={styles.adminRow}>
          <p className={styles.muted}>
            {t("등록만 해제하며 파일은 저장소에 남습니다.")}
          </p>
        </div>
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
    </>
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
      <div className={styles.memberPanel}>
        <p className={styles.muted}>{t("불러오는 중…")}</p>
      </div>
    );
  }

  const memberIds = new Set(members.map((member) => member.id));
  const addable = candidates.filter((user) => !memberIds.has(user.id));

  return (
    <div className={styles.memberPanel}>
      {members.length === 0 ? (
        <p className={styles.muted}>{t("구성원이 없습니다.")}</p>
      ) : (
        <ul className={styles.memberList}>
          {members.map((member) => (
            <li key={member.id} className={styles.memberItem}>
              <span style={{ minWidth: 0 }}>
                <span className={styles.deskName}>{member.name}</span>
                <span className={styles.memberMeta}>
                  {member.email} ·{" "}
                  {t(ROLE_LABELS[member.role as UserRole] ?? member.role)}
                </span>
              </span>
              <button
                type="button"
                className={`${styles.pixelButton} ${styles.dangerButton}`}
                disabled={busy}
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

      <div className={styles.addRow}>
        <select
          value={addUserId}
          onChange={(event) => setAddUserId(event.target.value)}
          aria-label={t("멤버 추가")}
          className={styles.input}
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
          className={styles.select}
        >
          {USER_ROLES.map((role) => (
            <option key={role} value={role}>
              {t(ROLE_LABELS[role])}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.pixelButton}
          disabled={busy || !addUserId}
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
      <p className={styles.muted}>
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
    <section className={styles.createCard}>
      <h2>{t("새 스페이스")}</h2>
      <form
        className={styles.createForm}
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
        <label className={styles.field}>
          <span>{t("주소")}</span>
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="sea"
            maxLength={32}
            className={styles.input}
          />
        </label>
        <label className={styles.field}>
          <span>{t("이름")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            className={styles.input}
          />
        </label>
        <button
          type="submit"
          className={styles.pixelButton}
          disabled={busy || !slug.trim() || !name.trim()}
        >
          {t("만들기")}
        </button>
      </form>
      <p className={styles.muted}>
        {t("주소는 영문 소문자·숫자·하이픈 1~32자입니다.")}
      </p>
    </section>
  );
}
