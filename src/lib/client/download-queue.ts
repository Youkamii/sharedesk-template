// 동시 다운로드 목록(#103)의 순수 상태 계산. 화면(FilesView)은 여기서 계산한
// 결과만 그리고, 실제 네트워크·파일 저장은 화면 쪽 실행기가 맡는다. 순수 모듈이라
// 브라우저 API에 손대지 않는다 — 테스트가 그대로 돌려 볼 수 있어야 한다.

// 한 번에 몇 개까지 실제로 받을지. 나머지는 "대기 중"으로 줄을 선다.
export const DOWNLOAD_CONCURRENCY = 3;

// 이보다 큰 파일은 메모리에 모으지 않고 브라우저 다운로드 관리자에 맡긴다.
export const LARGE_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type DownloadStatus = "queued" | "downloading" | "done" | "failed";

export type DownloadItem = {
  id: string;
  entryId: string;
  // 화면에 보여 줄 이름과 실제로 저장할 파일 이름은 다를 수 있다
  // (구글 문서는 .pdf가 붙는다).
  name: string;
  fileName: string;
  status: DownloadStatus;
  // 목록에서 본 파일 크기(모를 수 있음). 재시도해도 유지된다 — 실행기가
  // 대용량 여부(메모리 대신 브라우저 저장)를 판단하는 근거다.
  size: number | null;
  transferred: number;
  total: number | null;
  // 실패 사유는 한국어 원문으로 담아 두고 화면에서 t()로 번역한다.
  error: string | null;
};

export function newDownloadItem(
  id: string,
  entryId: string,
  name: string,
  fileName: string,
  size: number | null = null,
): DownloadItem {
  return {
    id,
    entryId,
    name,
    fileName,
    status: "queued",
    size,
    transferred: 0,
    total: size,
    error: null,
  };
}

export function runningDownloadCount(items: DownloadItem[]): number {
  return items.filter((item) => item.status === "downloading").length;
}

// 지금 새로 시작해도 되는 항목의 id 목록. 동시 실행 수가 캡을 넘지 않게 자른다.
export function nextDownloadStarts(
  items: DownloadItem[],
  cap: number = DOWNLOAD_CONCURRENCY,
): string[] {
  const room = Math.max(0, cap - runningDownloadCount(items));
  if (room === 0) return [];
  return items
    .filter((item) => item.status === "queued")
    .slice(0, room)
    .map((item) => item.id);
}

export function startDownloads(
  items: DownloadItem[],
  ids: Iterable<string>,
): DownloadItem[] {
  const starting = new Set(ids);
  return items.map((item) =>
    starting.has(item.id)
      ? { ...item, status: "downloading", transferred: 0, error: null }
      : item,
  );
}

export function patchDownloadItem(
  items: DownloadItem[],
  id: string,
  patch: Partial<DownloadItem>,
): DownloadItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

// 실패한 항목만 다시 줄 세운다 — 진행 중·완료 항목은 건드리지 않는다.
export function retryDownloadItem(
  items: DownloadItem[],
  id: string,
): DownloadItem[] {
  return items.map((item) =>
    item.id === id && item.status === "failed"
      ? { ...item, status: "queued", transferred: 0, total: null, error: null }
      : item,
  );
}

// 패널을 닫을 때 끝난 항목은 버리고 진행 중·대기 항목만 남긴다 —
// 목록이 비면 패널을 다시 열 이유도 없다.
export function pruneFinishedDownloads(items: DownloadItem[]): DownloadItem[] {
  return items.filter(
    (item) => item.status === "queued" || item.status === "downloading",
  );
}

export function downloadPercent(item: DownloadItem): number | null {
  if (item.status === "done") return 100;
  if (item.total === null || item.total <= 0) return null;
  const ratio = item.transferred / item.total;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export type DownloadQueueSummary = {
  total: number;
  done: number;
  failed: number;
  // 아직 끝나지 않은 항목(대기 + 받는 중).
  active: number;
};

export function downloadQueueSummary(
  items: DownloadItem[],
): DownloadQueueSummary {
  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  return {
    total: items.length,
    done,
    failed,
    active: items.length - done - failed,
  };
}

// Content-Length가 없거나 숫자가 아니면 진행률을 알 수 없다(불확정 표시).
export function parseContentLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header)) return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}
