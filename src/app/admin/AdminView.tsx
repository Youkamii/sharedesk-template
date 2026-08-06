"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@/lib/users";

const STATUS_LABEL: Record<User["status"], string> = {
  pending: "승인 대기",
  approved: "승인됨",
  blocked: "차단됨",
};

const STATUS_STYLE: Record<User["status"], string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
};

export default function AdminView() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users");
      if (res.status === 401 || res.status === 403) {
        router.replace("/files");
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "목록을 불러오지 못했습니다");
      setUsers(body.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "목록을 불러오지 못했습니다");
    }
    setLoading(false);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "처리하지 못했습니다");
      setConfirmRemoveId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다");
    }
    setBusyId(null);
  }

  const btn =
    "whitespace-nowrap rounded px-2 py-1 text-xs text-zinc-600 hover:bg-black/5 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-white/10";

  const pending = users.filter((u) => u.status === "pending");

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/15">
        <h1 className="text-lg font-semibold tracking-tight">사용자 관리</h1>
        <a
          href="/files"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          파일로 돌아가기
        </a>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
        {pending.length > 0 && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            승인을 기다리는 사람이 {pending.length}명 있습니다.
          </p>
        )}
        {error && (
          <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/15">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15 dark:text-zinc-400">
                <th className="px-4 py-2.5 font-medium">사용자</th>
                <th className="w-24 px-4 py-2.5 font-medium">상태</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-400">
                    불러오는 중...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-400">
                    아직 로그인한 사람이 없습니다
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-black/5 last:border-b-0 dark:border-white/5"
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium">
                        {u.name}
                        {u.isAdmin && (
                          <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-xs font-normal text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                            관리자
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {u.email}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[u.status]}`}
                      >
                        {STATUS_LABEL[u.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {u.isAdmin ? (
                        <span className="text-xs text-zinc-400">—</span>
                      ) : confirmRemoveId === u.id ? (
                        <span className="flex items-center justify-end gap-1">
                          <button
                            disabled={busyId === u.id}
                            onClick={() => void act(u.id, "remove")}
                            className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                          >
                            삭제 확인
                          </button>
                          <button
                            onClick={() => setConfirmRemoveId(null)}
                            className={btn}
                          >
                            취소
                          </button>
                        </span>
                      ) : (
                        <span className="flex items-center justify-end gap-1">
                          {u.status !== "approved" && (
                            <button
                              disabled={busyId === u.id}
                              onClick={() => void act(u.id, "approve")}
                              className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                            >
                              승인
                            </button>
                          )}
                          {u.status === "approved" && (
                            <>
                              <button
                                disabled={busyId === u.id}
                                onClick={() => void act(u.id, "revoke")}
                                className={btn}
                                title="이 사람의 모든 기기에서 로그인을 끊습니다"
                              >
                                세션 끊기
                              </button>
                              <button
                                disabled={busyId === u.id}
                                onClick={() => void act(u.id, "block")}
                                className={btn}
                              >
                                차단
                              </button>
                            </>
                          )}
                          {u.status === "blocked" && (
                            <button
                              disabled={busyId === u.id}
                              onClick={() => void act(u.id, "pending")}
                              className={btn}
                            >
                              대기로
                            </button>
                          )}
                          <button
                            onClick={() => setConfirmRemoveId(u.id)}
                            className={btn}
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
            차단·세션 끊기를 하면 그 사람의 기존 로그인은 무효가 되어, 다시 승인해도
            새로 로그인해야 합니다.
          </li>
        </ul>
      </main>
    </div>
  );
}
