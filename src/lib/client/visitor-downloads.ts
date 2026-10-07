// 로그인 없는 방문자 화면(공유 링크 받기 화면 #17 B-3·공개 폴더 #17 B-6)의
// 여러 파일 받기. 서버 zip 없이 데스크와 같은 줄 세우기(download-queue.ts)로
// DOWNLOAD_CONCURRENCY(3)개씩 차례로 받는다. 실제 받기·저장은 주입받아
// 테스트가 브라우저 없이 그대로 돌려 본다.

import { useState } from "react";
import {
  DOWNLOAD_CONCURRENCY,
  LARGE_DOWNLOAD_BYTES,
  downloadQueueSummary,
  newDownloadItem,
  nextDownloadStarts,
  patchDownloadItem,
  pruneFinishedDownloads,
  startDownloads,
  type DownloadItem,
  type DownloadQueueSummary,
} from "./download-queue";

export interface VisitorDownloadTarget {
  id: string;
  name: string;
  size: number | null;
}

// 브라우저 다운로드 관리자에 넘긴 파일이 큐의 자리를 붙잡고 있는 시간. 넘긴 뒤
// 언제 끝나는지는 페이지가 알 수 없어, 넘긴 파일들이 한꺼번에 시작되지 않게
// 이만큼 자리를 비우지 않는다(동시 3개 자리를 차례로 쓴다).
export const NATIVE_HANDOFF_HOLD_MS = 1_500;

export interface VisitorDownloadIo {
  fetchFile(url: string): Promise<Response>;
  // 메모리에 모은 파일을 저장 창으로 넘긴다.
  saveBlob(blob: Blob, fileName: string): void;
  // 크기를 모르거나 큰 파일은 브라우저 다운로드 관리자에 맡긴다(디스크로 바로).
  saveNative(url: string, fileName: string): void;
  // 넘긴 파일이 자리를 붙잡는 동안 기다린다.
  holdNative(): Promise<void>;
}

function clickAnchor(href: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export const browserDownloadIo: VisitorDownloadIo = {
  fetchFile: (url) => fetch(url, { cache: "no-store" }),
  saveBlob(blob, fileName) {
    const href = URL.createObjectURL(blob);
    clickAnchor(href, fileName);
    // 클릭 직후에 해제하면 저장이 취소되는 브라우저가 있어 한 박자 늦춘다(데스크와 같다).
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  },
  saveNative: clickAnchor,
  holdNative: () =>
    new Promise((resolve) => window.setTimeout(resolve, NATIVE_HANDOFF_HOLD_MS)),
};

// 메모리에 모아도 되는 파일인가. 크기를 모르면(목록에 크기가 없으면) 얼마나 클지
// 몰라 모으지 않는다 — 동시 3개가 겹쳐 탭이 죽지 않게.
export function fitsInMemory(size: number | null): boolean {
  return size !== null && size <= LARGE_DOWNLOAD_BYTES;
}

export interface VisitorDownloadRunner {
  enqueue(targets: readonly VisitorDownloadTarget[]): void;
  // 끝난(완료·실패) 항목을 지운다 — 새 묶음을 시작할 때 부른다.
  clearFinished(): void;
  items(): DownloadItem[];
}

let fallbackId = 0;
function defaultMakeId(): string {
  fallbackId += 1;
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `visitor-download-${fallbackId}`;
}

export function createVisitorDownloadRunner(options: {
  // entry id → 내려받기 주소. 화면이 사는 동안 바뀌지 않는 값(링크·토큰)으로 만든다.
  urlFor: (entryId: string) => string;
  onChange: (items: DownloadItem[]) => void;
  io?: VisitorDownloadIo;
  concurrency?: number;
  makeId?: () => string;
}): VisitorDownloadRunner {
  const io = options.io ?? browserDownloadIo;
  const concurrency = options.concurrency ?? DOWNLOAD_CONCURRENCY;
  const makeId = options.makeId ?? defaultMakeId;
  let items: DownloadItem[] = [];

  const write = (next: DownloadItem[]) => {
    items = next;
    options.onChange(next);
  };

  const pump = () => {
    const starts = nextDownloadStarts(items, concurrency);
    if (starts.length === 0) return;
    write(startDownloads(items, starts));
    for (const id of starts) void run(id);
  };

  async function run(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    const url = options.urlFor(item.entryId);
    try {
      if (!fitsInMemory(item.size)) {
        // 브라우저에 넘기고, 자리는 잠시 붙잡는다(한꺼번에 시작하지 않게).
        io.saveNative(url, item.fileName);
        await io.holdNative();
        write(
          patchDownloadItem(items, id, {
            status: "done",
            transferred: item.size ?? 0,
            total: item.size,
          }),
        );
        return;
      }
      const response = await io.fetchFile(url);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("다운로드를 시작하지 못했습니다");
      }
      const blob = await response.blob();
      io.saveBlob(blob, item.fileName);
      write(
        patchDownloadItem(items, id, {
          status: "done",
          transferred: blob.size,
          total: blob.size,
        }),
      );
    } catch {
      write(
        patchDownloadItem(items, id, {
          status: "failed",
          error: "다운로드에 실패했습니다",
        }),
      );
    } finally {
      // 자리가 비었으니 기다리던 다음 파일을 올린다.
      pump();
    }
  }

  return {
    enqueue(targets) {
      const fresh = targets.map((target) =>
        newDownloadItem(makeId(), target.id, target.name, target.name, target.size),
      );
      if (fresh.length === 0) return;
      write([...items, ...fresh]);
      pump();
    },
    clearFinished() {
      write(pruneFinishedDownloads(items));
    },
    items: () => items,
  };
}

export type VisitorDownloadTranslator = (
  text: string,
  vars?: Record<string, string | number>,
) => string;

// 두 방문자 화면(받기 화면 모두 받기·공개 폴더 선택 받기)의 진행 문구. 받은 적이
// 없으면 null.
export function formatVisitorDownloadStatus(
  summary: DownloadQueueSummary,
  t: VisitorDownloadTranslator,
): string | null {
  if (summary.total === 0) return null;
  if (summary.active > 0) {
    return t("내려받는 중 {done}/{total}", {
      done: summary.done + summary.failed,
      total: summary.total,
    });
  }
  return summary.failed === 0
    ? t("{count}개를 내려받았습니다", { count: summary.done })
    : t("{done}개 받음 · {failed}개 실패", {
        done: summary.done,
        failed: summary.failed,
      });
}

// 화면용 훅. urlFor는 처음 값으로 고정된다(링크·토큰은 화면이 사는 동안 같다).
export function useVisitorDownloads(urlFor: (entryId: string) => string): {
  summary: DownloadQueueSummary;
  enqueue: (targets: readonly VisitorDownloadTarget[]) => void;
} {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [runner] = useState(() =>
    createVisitorDownloadRunner({ urlFor, onChange: setItems }),
  );
  return {
    summary: downloadQueueSummary(items),
    enqueue: (targets) => {
      // 지난 묶음이 다 끝났으면 정리하고 새로 센다("2/2 받음" 뒤 "1/3"이 아니라 "0/1").
      if (downloadQueueSummary(runner.items()).active === 0) runner.clearFinished();
      runner.enqueue(targets);
    },
  };
}
