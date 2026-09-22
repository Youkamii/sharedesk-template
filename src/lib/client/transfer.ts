import { apiPath } from "@/lib/client/api-path";

export type TransferKind = "upload" | "download";

export type TransferProgress = {
  id: string;
  kind: TransferKind;
  name: string;
  transferred: number;
  total: number | null;
};

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function transferProgressText(transfer: TransferProgress): string {
  const current = formatTransferBytes(transfer.transferred);
  return transfer.total === null
    ? current
    : `${current} / ${formatTransferBytes(transfer.total)}`;
}

type UploadResult = {
  status: number;
  responseText: string;
};

const UPLOAD_RESERVATION_HEARTBEAT_MS = 60 * 60 * 1000;

export function startUploadReservationHeartbeat(
  reservationId: string | undefined,
): () => void {
  if (!reservationId) return () => undefined;
  const timer = window.setInterval(() => {
    void fetch(apiPath("/api/drive/upload-reservation"), {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId }),
    }).catch(() => undefined);
  }, UPLOAD_RESERVATION_HEARTBEAT_MS);
  return () => window.clearInterval(timer);
}

export function uploadWithProgress(
  url: string,
  method: "POST" | "PUT",
  body: Blob,
  contentType: string | null,
  onProgress: (transferred: number, total: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.upload.addEventListener("progress", (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : body.size);
    });
    request.open(method, url);
    if (contentType) request.setRequestHeader("Content-Type", contentType);
    request.addEventListener("load", () =>
      resolve({ status: request.status, responseText: request.responseText }),
    );
    request.addEventListener("error", () => reject(new Error("네트워크 연결이 끊겼습니다")));
    request.addEventListener("abort", () => reject(new DOMException("중단됨", "AbortError")));
    request.send(body);
  });
}

type FileSystemWritable = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

type SaveFileHandle = { createWritable(): Promise<FileSystemWritable> };

type SaveFilePicker = (options: {
  suggestedName: string;
}) => Promise<SaveFileHandle>;

export async function streamDownloadToDisk(
  url: string,
  name: string,
  onProgress: (transferred: number, total: number | null) => void,
): Promise<"saved" | "native"> {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (!picker) return "native";

  const handle = await picker.call(window, { suggestedName: name });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || !response.body) {
    throw new Error("다운로드를 시작하지 못했습니다");
  }
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null;
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let transferred = 0;
  onProgress(0, total);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await writable.write(chunk.value);
      transferred += chunk.value.byteLength;
      onProgress(transferred, total);
    }
    await writable.close();
    return "saved";
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await writable.abort?.().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024;

export function parseResumableRangeHeader(range: string | null): number {
  const match = range?.trim().match(/^bytes=0-(\d+)$/i);
  if (!match) return 0;
  const offset = Number(match[1]) + 1;
  return Number.isSafeInteger(offset) ? offset : 0;
}

export function nextChunkRange(
  offset: number,
  total: number,
  chunkSize = RESUMABLE_CHUNK_SIZE,
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("업로드 위치와 파일 크기는 0 이상의 정수여야 합니다");
  }
  // 빈 파일은 uploadResumable에서 bytes */0으로 한 번 PUT하고 200/201을 완료로 본다.
  if (offset >= total) return null;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("업로드 조각 크기는 양의 정수여야 합니다");
  }
  if (total - offset > chunkSize && chunkSize % (256 * 1024) !== 0) {
    throw new RangeError("마지막 업로드 조각을 제외한 크기는 256 KiB의 배수여야 합니다");
  }
  return { start: offset, end: Math.min(offset + chunkSize, total) - 1 };
}

export type ResumableStatus =
  | { kind: "incomplete"; offset: number }
  | { kind: "complete"; fileId: string | null }
  | { kind: "gone" };

type ResumableResponse = UploadResult & { range: string | null };

class RetryableUploadError extends Error {}

// 이어올릴 수 없는 오류만 호출부에서 기록을 지울 수 있게 구분한다.
export class PermanentUploadError extends Error {}

function resumableHttpError(status: number): Error {
  const message = `드라이브 업로드에 실패했습니다 (HTTP ${status})`;
  return status === 0 || (status >= 500 && status < 600)
    ? new RetryableUploadError(message)
    : new PermanentUploadError(message);
}

function sendXhr(options: {
  sessionUrl: string;
  contentRange: string;
  body: Blob | null;
  xhrFactory: () => XMLHttpRequest;
  onProgress?: (loaded: number) => void;
}): Promise<ResumableResponse> {
  return new Promise((resolve, reject) => {
    const request = options.xhrFactory();
    if (options.onProgress) {
      request.upload.addEventListener("progress", (event) => options.onProgress?.(event.loaded));
    }
    request.open("PUT", options.sessionUrl);
    request.setRequestHeader("Content-Range", options.contentRange);
    request.addEventListener("load", () => resolve({
      status: request.status,
      responseText: request.responseText,
      range: request.getResponseHeader("Range"),
    }));
    request.addEventListener("error", () => reject(new RetryableUploadError("네트워크 연결이 끊겼습니다")));
    request.addEventListener("timeout", () => reject(new RetryableUploadError("업로드 응답 시간이 초과되었습니다")));
    request.addEventListener("abort", () => reject(new DOMException("중단됨", "AbortError")));
    request.send(options.body);
  });
}

function resumableStatus(response: ResumableResponse): ResumableStatus {
  if (response.status === 308) {
    return { kind: "incomplete", offset: parseResumableRangeHeader(response.range) };
  }
  if (response.status === 200 || response.status === 201) {
    let fileId: string | null = null;
    try {
      const file: unknown = JSON.parse(response.responseText);
      if (file && typeof file === "object" && "id" in file && typeof file.id === "string") {
        fileId = file.id;
      }
    } catch {
      // 완료 응답에 파일 정보가 없으면 호출자가 나중에 목록에서 확인한다.
    }
    return { kind: "complete", fileId };
  }
  if (response.status === 404 || response.status === 410) return { kind: "gone" };
  throw resumableHttpError(response.status);
}

export async function queryResumableStatus(
  sessionUrl: string,
  total: number,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<ResumableStatus> {
  return resumableStatus(await sendXhr({
    sessionUrl,
    contentRange: `bytes */${total}`,
    body: null,
    xhrFactory,
  }));
}

export async function uploadResumable(options: {
  sessionUrl: string;
  file: Blob;
  startOffset?: number;
  chunkSize?: number;
  onProgress?: (transferred: number, total: number) => void;
  onChunkSent?: (offset: number) => void | Promise<void>;
  signal?: AbortSignal;
  xhrFactory?: () => XMLHttpRequest;
}): Promise<{ fileId: string | null; responseText: string }> {
  const { sessionUrl, file, signal, onProgress, onChunkSent } = options;
  const total = file.size;
  let offset = options.startOffset ?? 0;
  let request: XMLHttpRequest | undefined;
  const checkAborted = () => {
    if (signal?.aborted) throw new DOMException("중단됨", "AbortError");
  };
  checkAborted();
  const xhrFactory = () => {
    checkAborted();
    request = options.xhrFactory ? options.xhrFactory() : new XMLHttpRequest();
    return request;
  };

  const run = async () => {
    let retries = 0;
    let recovering = false;
    for (;;) {
      checkAborted();
      let status: ResumableStatus;
      let responseText: string;
      try {
        if (recovering) {
          status = await queryResumableStatus(sessionUrl, total, xhrFactory);
          responseText = request?.responseText ?? "";
        } else {
          const range = nextChunkRange(offset, total, options.chunkSize);
          const start = offset;
          const response = await sendXhr({
            sessionUrl,
            contentRange: range ? `bytes ${range.start}-${range.end}/${total}` : `bytes */${total}`,
            body: range ? file.slice(range.start, range.end + 1) : null,
            xhrFactory,
            onProgress: (loaded) => onProgress?.(start + loaded, total),
          });
          if (response.status === 404 || response.status === 410) {
            throw resumableHttpError(response.status);
          }
          status = resumableStatus(response);
          responseText = response.responseText;
        }
      } catch (error) {
        if (!(error instanceof RetryableUploadError) || retries >= 3) throw error;
        retries += 1;
        // 전송 실패 뒤에는 서버에 저장된 위치부터 확인한다. 조회 실패도 재시도 횟수에 센다.
        recovering = true;
        continue;
      }
      checkAborted();
      if (status.kind === "gone") throw new PermanentUploadError("드라이브 업로드 세션이 만료되었습니다");
      if (status.kind === "complete") {
        onProgress?.(total, total);
        return { fileId: status.fileId, responseText };
      }
      if (status.offset > total) throw new PermanentUploadError("서버의 업로드 위치가 파일 크기를 넘었습니다");
      await onChunkSent?.(status.offset);
      if (!recovering) {
        if (status.offset > offset) {
          retries = 0;
        } else if (retries >= 3) {
          throw new PermanentUploadError("드라이브 업로드가 더 진행되지 않습니다");
        } else {
          retries += 1;
        }
      }
      offset = status.offset;
      recovering = false;
    }
  };

  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      reject(new DOMException("중단됨", "AbortError"));
      request?.abort();
    };
  });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // 조각 기록을 저장하는 동안 중단해도 호출자는 바로 결과를 받는다.
    return await Promise.race([run(), aborted]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
