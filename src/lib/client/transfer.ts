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
