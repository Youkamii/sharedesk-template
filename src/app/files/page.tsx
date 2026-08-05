"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Entry } from "@/lib/storage/types";

type Crumb = { id: string; name: string };

function formatSize(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = size;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export default function FilesPage() {
  const router = useRouter();
  const [path, setPath] = useState<Crumb[]>([
    { id: "root", name: "공유 드라이브" },
  ]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = path[path.length - 1];

  const load = useCallback(
    async (folderId: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/drive/list?folderId=${encodeURIComponent(folderId)}`,
        );
        if (res.status === 401) {
          router.replace("/");
          return;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error ?? "목록을 불러오지 못했습니다");
        }
        setEntries(body.entries);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "목록을 불러오지 못했습니다",
        );
      }
      setLoading(false);
    },
    [router],
  );

  useEffect(() => {
    void load(current.id);
  }, [current.id, load]);

  async function logout() {
    await fetch("/api/auth", { method: "DELETE" });
    router.replace("/");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/15">
        <h1 className="text-lg font-semibold tracking-tight">ShareDesk</h1>
        <button
          onClick={() => void logout()}
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          로그아웃
        </button>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          {path.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-zinc-400">/</span>}
              <button
                onClick={() => setPath(path.slice(0, i + 1))}
                disabled={i === path.length - 1}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 disabled:font-medium disabled:hover:bg-transparent dark:hover:bg-white/10"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="mt-4 overflow-x-auto rounded-xl border border-black/10 dark:border-white/15">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15 dark:text-zinc-400">
                <th className="px-4 py-2.5 font-medium">이름</th>
                <th className="w-24 px-4 py-2.5 font-medium">크기</th>
                <th className="w-36 px-4 py-2.5 font-medium">수정일</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-400">
                    불러오는 중...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-8 text-center text-red-600 dark:text-red-400"
                  >
                    {error}
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-400">
                    비어 있습니다
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-black/5 last:border-b-0 dark:border-white/5"
                  >
                    <td className="px-4 py-2">
                      {entry.isFolder ? (
                        <button
                          onClick={() =>
                            setPath([
                              ...path,
                              { id: entry.id, name: entry.name },
                            ])
                          }
                          className="flex items-center gap-2 hover:underline"
                        >
                          <span aria-hidden>📁</span>
                          {entry.name}
                        </button>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span aria-hidden>📄</span>
                          {entry.name}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                      {formatSize(entry.size)}
                    </td>
                    <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                      {formatDate(entry.modifiedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
