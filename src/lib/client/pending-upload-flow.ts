import { spaceSlugFromPathname } from "@/lib/client/api-path";
import {
  isTrustedResumableSessionUrl,
  listPendingUploads,
  type PendingUpload,
  type PendingUploadStore,
} from "@/lib/client/pending-uploads";
import {
  PermanentUploadError,
  startUploadReservationHeartbeat,
  uploadResumable,
} from "@/lib/client/transfer";

// HTTP 오류는 status를 붙인 Error로 전달한다.
export type PendingUploadPoster = (path: string, body: unknown) => Promise<unknown>;

type UploadProgress = (transferred: number, total: number) => void;

export type PendingUploadFlow = {
  setContext(context: string): void;
  load(): Promise<PendingUpload[]>;
  createRecord(input: {
    id?: string;
    sessionUrl: string;
    reservationId: string | null;
    parentId: string;
    file: File;
  }): PendingUpload;
  remove(id: string): Promise<void>;
  uploadDirect(
    record: PendingUpload,
    file: File,
    onProgress: UploadProgress,
    options: { persist: boolean },
  ): Promise<string | null>;
  isTrusted(record: PendingUpload): boolean;
  checkReservation(record: PendingUpload): Promise<"ok" | "reservation-expired">;
  resume(record: PendingUpload, file: File, onProgress: UploadProgress): Promise<string | null>;
};

export function pendingUploadContext(pathname: string, userEmail: string): string {
  return `${spaceSlugFromPathname(pathname) ?? ""}:${userEmail}`;
}

export function createPendingUploadFlow(deps: {
  store: PendingUploadStore;
  post: PendingUploadPoster;
  onRecordsChange: (update: (current: PendingUpload[]) => PendingUpload[]) => void;
  xhrFactory?: () => XMLHttpRequest;
  startHeartbeat?: typeof startUploadReservationHeartbeat;
}): PendingUploadFlow {
  const { store, post, onRecordsChange, xhrFactory, startHeartbeat = startUploadReservationHeartbeat } = deps;
  let context = "";

  async function saveProgress(record: PendingUpload, uploadedBytes: number) {
    // 호출자가 들고 있는 기록도 갱신해 실패 뒤 목록에 최신 진행량을 남긴다.
    record.uploadedBytes = uploadedBytes;
    record.updatedAt = Date.now();
    const updated = { ...record };
    try {
      await store.put(updated);
    } catch {
      // 기록을 저장하지 못해도 파일 전송은 계속한다.
    }
    onRecordsChange((current) => current.map((item) =>
      item.id === record.id ? updated : item,
    ));
  }

  async function complete(record: PendingUpload, fileId: string | null, persist: boolean) {
    // 완료 알림만 실패했을 때도 다음에는 전송이 끝난 위치부터 확인한다.
    if (persist) await saveProgress(record, record.size);
    if (record.reservationId && fileId) {
      try {
        await post("/api/drive/upload-complete", {
          reservationId: record.reservationId,
          fileId,
        });
      } catch (error) {
        if (error instanceof Error && "status" in error && error.status === 409) {
          throw new PermanentUploadError(error.message);
        }
        throw error;
      }
    }
    if (persist) await flow.remove(record.id).catch(() => undefined);
  }

  async function transfer(
    record: PendingUpload,
    file: File,
    onProgress: UploadProgress,
    options: { verifyOffset: boolean; startOffset: number; persist: boolean },
  ) {
    const stopHeartbeat = startHeartbeat(record.reservationId ?? undefined);
    try {
      const result = await uploadResumable({
        sessionUrl: record.sessionUrl,
        file,
        startOffset: options.startOffset,
        verifyOffset: options.verifyOffset,
        onProgress,
        onChunkSent: options.persist ? (offset) => saveProgress(record, offset) : undefined,
        xhrFactory,
      });
      await complete(record, result.fileId, options.persist);
      return result.fileId;
    } finally {
      stopHeartbeat();
    }
  }

  const flow: PendingUploadFlow = {
    setContext(nextContext) {
      context = nextContext;
    },
    load() {
      return listPendingUploads(store, context);
    },
    createRecord({ id, sessionUrl, reservationId, parentId, file }) {
      const now = Date.now();
      return {
        id: id ?? crypto.randomUUID(),
        sessionUrl,
        reservationId,
        parentId,
        context,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        uploadedBytes: 0,
        createdAt: now,
        updatedAt: now,
      };
    },
    async remove(id) {
      await store.remove(id);
      onRecordsChange((current) => current.filter((item) => item.id !== id));
    },
    async uploadDirect(record, file, onProgress, options) {
      // 새로고침 뒤 이어올릴 수 있게 첫 전송 전에 기록 저장을 시도한다.
      if (options.persist) {
        try {
          await store.put(record);
        } catch {
          // 기록을 저장하지 못해도 파일 전송은 시작한다.
        }
      }
      try {
        return await transfer(record, file, onProgress, {
          verifyOffset: false,
          startOffset: 0,
          persist: options.persist,
        });
      } catch (error) {
        if (!options.persist) throw error;
        if (error instanceof PermanentUploadError) {
          await flow.remove(record.id).catch(() => undefined);
        } else {
          onRecordsChange((current) => [
            ...current.filter((item) => item.id !== record.id),
            record,
          ]);
        }
        throw error;
      }
    },
    isTrusted(record) {
      return isTrustedResumableSessionUrl(record.sessionUrl);
    },
    async checkReservation(record) {
      if (record.reservationId) {
        try {
          await post("/api/drive/upload-reservation", { reservationId: record.reservationId });
        } catch (error) {
          if (error instanceof Error && "status" in error && error.status === 409) {
            await flow.remove(record.id).catch(() => undefined);
            return "reservation-expired";
          }
          throw error;
        }
      }
      return "ok";
    },
    async resume(record, file, onProgress) {
      try {
        return await transfer(record, file, onProgress, {
          verifyOffset: true,
          startOffset: record.uploadedBytes,
          persist: true,
        });
      } catch (error) {
        if (error instanceof PermanentUploadError) {
          await flow.remove(record.id).catch(() => undefined);
        }
        throw error;
      }
    },
  };
  return flow;
}
