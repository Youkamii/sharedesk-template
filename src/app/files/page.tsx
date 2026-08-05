"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Entry, UploadSession } from "@/lib/storage/types";

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
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
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

  async function uploadOne(file: File): Promise<void> {
    const mimeType = file.type || "application/octet-stream";
    const sessRes = await fetch("/api/drive/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentId: current.id,
        name: file.name,
        mimeType,
        size: file.size,
      }),
    });
    if (!sessRes.ok) {
      const body = await sessRes.json().catch(() => null);
      throw new Error(body?.error ?? "업로드 준비에 실패했습니다");
    }
    const session: UploadSession = await sessRes.json();
    if (session.mode === "direct") {
      const put = await fetch(session.url, { method: "PUT", body: file });
      if (!put.ok) throw new Error("드라이브 업로드에 실패했습니다");
      return;
    }
    const res = await fetch(
      `/api/drive/upload?parentId=${encodeURIComponent(current.id)}&name=${encodeURIComponent(file.name)}`,
      { method: "POST", headers: { "Content-Type": mimeType }, body: file },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? "업로드에 실패했습니다");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setNotice(`업로드 중 (${i + 1}/${list.length}) — ${list[i].name}`);
      try {
        await uploadOne(list[i]);
      } catch (e) {
        failed.push(
          `${list[i].name}: ${e instanceof Error ? e.message : "실패"}`,
        );
      }
    }
    setNotice(failed.length ? `실패 — ${failed.join(", ")}` : null);
    await load(current.id);
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
        <div className="flex items-center justify-between gap-4">
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
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background"
            >
              업로드
            </button>
          </div>
        </div>

        {notice && (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            {notice}
          </p>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) {
              void uploadFiles(e.dataTransfer.files);
            }
          }}
          className={`mt-4 overflow-x-auto rounded-xl border ${
            dragOver
              ? "border-blue-400 bg-blue-50/50 dark:bg-blue-950/20"
              : "border-black/10 dark:border-white/15"
          }`}
        >
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
                    비어 있습니다 — 파일을 끌어다 놓으면 업로드됩니다
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
                        <a
                          href={`/api/drive/download?id=${encodeURIComponent(entry.id)}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <span aria-hidden>📄</span>
                          {entry.name}
                        </a>
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
