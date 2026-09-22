export const PENDING_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 새 기록의 id는 crypto.randomUUID(), 생성·수정 시간은 Date.now()로 만든다.
export type PendingUpload = {
  id: string;
  sessionUrl: string;
  reservationId: string | null;
  parentId: string;
  context: string;
  name: string;
  size: number;
  lastModified: number;
  uploadedBytes: number;
  createdAt: number;
  updatedAt: number;
};

export type PendingUploadStore = {
  list(): Promise<PendingUpload[]>;
  put(record: PendingUpload): Promise<void>;
  remove(id: string): Promise<void>;
};

export function createMemoryPendingUploadStore(): PendingUploadStore {
  const records = new Map<string, PendingUpload>();
  return {
    async list() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    async put(record) {
      records.set(record.id, { ...record });
    },
    async remove(id) {
      records.delete(id);
    },
  };
}

function runUploadRequest<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("uploads", mode);
    const request = createRequest(transaction.objectStore("uploads"));
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("업로드 기록 저장이 중단되었습니다"));
    // 요청 성공 뒤에도 저장이 취소될 수 있으므로 트랜잭션 완료까지 기다린다.
    transaction.oncomplete = () => resolve(request.result);
  });
}

export function createIndexedDbPendingUploadStore(
  dbName = "sharedesk-pending-uploads",
  indexedDbFactory?: IDBFactory,
): PendingUploadStore {
  const memory = createMemoryPendingUploadStore();
  let database: Promise<IDBDatabase | null> | undefined;
  const open = () => {
    database ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        // 가져오기나 저장소 생성 시점에는 브라우저 API를 읽지 않는다.
        const factory = indexedDbFactory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
        if (!factory) {
          resolve(null);
          return;
        }
        const request = factory.open(dbName, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("uploads")) {
            request.result.createObjectStore("uploads", { keyPath: "id" });
          }
        };
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const connection = request.result;
          connection.onversionchange = () => connection.close();
          resolve(connection);
        };
      } catch {
        resolve(null);
      }
    });
    return database;
  };
  return {
    async list() {
      const connection = await open();
      return connection
        ? runUploadRequest<PendingUpload[]>(connection, "readonly", (store) => store.getAll())
        : memory.list();
    },
    async put(record) {
      const connection = await open();
      if (!connection) return memory.put(record);
      await runUploadRequest(connection, "readwrite", (store) => store.put(record));
    },
    async remove(id) {
      const connection = await open();
      if (!connection) return memory.remove(id);
      await runUploadRequest(connection, "readwrite", (store) => store.delete(id));
    },
  };
}

export function isTrustedResumableSessionUrl(url: string): boolean {
  return url.startsWith("https://www.googleapis.com/upload/");
}

export function isPendingUploadExpired(record: PendingUpload, now = Date.now()): boolean {
  // 구글 resumable 세션 URL은 만든 지 일주일이면 죽는다 — 생성 시각 기준으로 지운다.
  return now - record.createdAt >= PENDING_UPLOAD_TTL_MS;
}

export function matchPendingUpload(
  records: PendingUpload[],
  file: { name: string; size: number; lastModified: number },
): PendingUpload | null {
  let match: PendingUpload | null = null;
  for (const record of records) {
    if (record.name !== file.name || record.size !== file.size || record.lastModified !== file.lastModified) continue;
    if (!match || record.updatedAt > match.updatedAt) match = record;
  }
  return match;
}

export async function listPendingUploads(
  store: PendingUploadStore,
  context: string,
  now = Date.now(),
): Promise<PendingUpload[]> {
  const records = await store.list();
  await Promise.all(records
    .filter((record) => isPendingUploadExpired(record, now))
    .map((record) => store.remove(record.id)));
  return records
    .filter((record) => record.context === context && !isPendingUploadExpired(record, now))
    .sort((left, right) => left.createdAt - right.createdAt);
}
