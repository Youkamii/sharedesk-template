// 파일 한 건 업로드 흐름 — 데스크 화면(FilesView)과 위젯 화면이 같은 경로를 쓴다.
// 서버가 정한 방식대로 Drive 직행(PUT) 또는 서버 경유(POST)로 올리고,
// 직행이면 예약 완료(upload-complete)까지 마무리한다. 진행률은 콜백으로 준다.

import type { Entry, UploadSession } from "@/lib/storage/types";
import { apiPath } from "@/lib/client/api-path";
import {
  startUploadReservationHeartbeat,
  uploadWithProgress,
} from "@/lib/client/transfer";

export interface UploadEntryMessages {
  driveFailed: string;
  sessionExpired: string;
  uploadFailed: string;
}

export interface UploadEntryDeps {
  apiJson: <T>(pathname: string, init: RequestInit) => Promise<T>;
  onProgress: (transferred: number, total: number) => void;
  onSessionExpired: () => void;
  messages: UploadEntryMessages;
  // 테스트에서 XHR 없이 흐름만 검증할 수 있게 바꿔 끼운다.
  upload?: typeof uploadWithProgress;
  heartbeat?: typeof startUploadReservationHeartbeat;
}

export async function uploadEntry(
  file: File,
  folderId: string,
  deps: UploadEntryDeps,
): Promise<string | null> {
  const upload = deps.upload ?? uploadWithProgress;
  const heartbeat = deps.heartbeat ?? startUploadReservationHeartbeat;
  const mimeType = file.type || "application/octet-stream";
  const session = await deps.apiJson<UploadSession>(apiPath("/api/drive/upload-session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parentId: folderId,
      name: file.name,
      mimeType,
      size: file.size,
    }),
  });
  if (session.mode === "direct") {
    const stopHeartbeat = heartbeat(session.reservationId);
    try {
      const response = await upload(
        session.url,
        "PUT",
        file,
        null,
        deps.onProgress,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(deps.messages.driveFailed);
      }
      const body = JSON.parse(response.responseText || "null") as {
        id?: string;
      } | null;
      if (session.reservationId && body?.id) {
        await deps.apiJson(apiPath("/api/drive/upload-complete"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reservationId: session.reservationId,
            fileId: body.id,
          }),
        });
      }
      return body?.id ?? null;
    } finally {
      stopHeartbeat();
    }
  }
  const reservationQuery = session.reservationId
    ? `&reservationId=${encodeURIComponent(session.reservationId)}`
    : "";
  const response = await upload(
    apiPath(
      `/api/drive/upload?parentId=${encodeURIComponent(folderId)}&name=${encodeURIComponent(file.name)}${reservationQuery}`,
    ),
    "POST",
    file,
    mimeType,
    deps.onProgress,
  );
  if (response.status === 401) {
    deps.onSessionExpired();
    throw new Error(deps.messages.sessionExpired);
  }
  const body = JSON.parse(response.responseText || "null") as {
    error?: string;
    entry?: Entry;
  } | null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(body?.error ?? deps.messages.uploadFailed);
  }
  return body?.entry?.id ?? null;
}
