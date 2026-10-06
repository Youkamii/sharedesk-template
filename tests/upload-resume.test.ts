import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  createPendingUploadFlow,
  pendingUploadContext,
  type PendingUploadPoster,
} from "../src/lib/client/pending-upload-flow";
import {
  PermanentUploadError,
  RESUMABLE_CHUNK_SIZE,
  nextChunkRange,
  parseResumableRangeHeader,
  queryResumableStatus,
  uploadResumable,
} from "../src/lib/client/transfer";
import {
  PENDING_UPLOAD_TTL_MS,
  createIndexedDbPendingUploadStore,
  createMemoryPendingUploadStore,
  isPendingUploadExpired,
  isTrustedResumableSessionUrl,
  listPendingUploads,
  matchPendingUpload,
  type PendingUpload,
} from "../src/lib/client/pending-uploads";

const CHUNK = 256 * 1024;
const SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?upload_id=test";
const CONTEXT = "desk:user@example.test";
const NOW = 1_800_000_000_000;

type ScriptedResponse = {
  status?: number;
  range?: string | null;
  responseText?: string;
  event?: "load" | "error" | "timeout";
  loaded?: number[];
};

type FakeListener = (event: { loaded: number; total: number; lengthComputable: boolean }) => void;

class FakeXhr {
  status = 0;
  responseText = "";
  method = "";
  url = "";
  body: Blob | null = null;
  headers = new Map<string, string>();
  private listeners = new Map<string, FakeListener[]>();
  private progressListeners: FakeListener[] = [];
  upload = {
    addEventListener: (type: string, listener: FakeListener) => {
      assert.equal(type, "progress");
      this.progressListeners.push(listener);
    },
  };

  constructor(private response: ScriptedResponse, private onSend?: () => void) {}

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  addEventListener(type: string, listener: FakeListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  getResponseHeader(name: string) {
    return name.toLowerCase() === "range" ? this.response.range ?? null : null;
  }

  private emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ loaded: 0, total: 0, lengthComputable: false });
    }
  }

  send(body: Blob | null) {
    this.body = body;
    this.onSend?.();
    queueMicrotask(() => {
      for (const loaded of this.response.loaded ?? []) {
        for (const listener of this.progressListeners) {
          listener({ loaded, total: 0, lengthComputable: false });
        }
      }
      this.status = this.response.status ?? 0;
      this.responseText = this.response.responseText ?? "";
      this.emit(this.response.event ?? "load");
    });
  }

}

function scriptedXhr(responses: ScriptedResponse[], onSend?: () => void) {
  const requests: FakeXhr[] = [];
  return {
    requests,
    xhrFactory: () => {
      const response = responses[requests.length];
      assert.ok(response, "예정에 없는 추가 요청이 발생했습니다");
      const request = new FakeXhr(response, onSend);
      requests.push(request);
      return request as unknown as XMLHttpRequest;
    },
  };
}

function assertRanges(requests: FakeXhr[], ranges: string[]) {
  assert.deepEqual(requests.map((request) => request.headers.get("Content-Range")), ranges);
  for (const request of requests) {
    assert.equal(request.method, "PUT");
    assert.equal(request.url, SESSION_URL);
  }
}

function pending(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    id: crypto.randomUUID(),
    sessionUrl: SESSION_URL,
    reservationId: null,
    parentId: "root",
    context: CONTEXT,
    name: "영상.mp4",
    size: 1024,
    lastModified: NOW - 1000,
    uploadedBytes: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("재개 Range 헤더는 저장된 바이트 수로 바꾸고 잘못된 값은 0으로 본다", () => {
  assert.equal(parseResumableRangeHeader(null), 0);
  assert.equal(parseResumableRangeHeader(""), 0);
  assert.equal(parseResumableRangeHeader("bytes=0-1048575"), 1048576);
  assert.equal(parseResumableRangeHeader("bytes=0-0"), 1);
  assert.equal(parseResumableRangeHeader("  bytes=0-255  "), 256);
  for (const value of ["garbage", "bytes=1-100", "bytes=0--1", "bytes=0-1.5", "bytes=0-99junk", "bytes=0-9007199254740991"]) {
    assert.equal(parseResumableRangeHeader(value), 0);
  }
});

test("조각 범위는 256 KiB 배수이고 마지막 바이트를 포함한다", () => {
  assert.equal(RESUMABLE_CHUNK_SIZE, 8 * 1024 * 1024);
  assert.equal(RESUMABLE_CHUNK_SIZE % CHUNK, 0);
  assert.deepEqual(nextChunkRange(0, RESUMABLE_CHUNK_SIZE * 2), {
    start: 0, end: RESUMABLE_CHUNK_SIZE - 1,
  });
  assert.deepEqual(nextChunkRange(CHUNK, CHUNK * 3, CHUNK), {
    start: CHUNK, end: CHUNK * 2 - 1,
  });
  assert.deepEqual(nextChunkRange(CHUNK * 2, CHUNK * 2 + 17, CHUNK), {
    start: CHUNK * 2, end: CHUNK * 2 + 16,
  });
  assert.equal(nextChunkRange(10, 10), null);
  assert.equal(nextChunkRange(11, 10), null);
  assert.equal(nextChunkRange(0, 0), null);
  assert.throws(() => nextChunkRange(0, CHUNK, 0), RangeError);
  assert.throws(() => nextChunkRange(0, CHUNK, CHUNK - 1), RangeError);
  assert.throws(() => nextChunkRange(-1, CHUNK), RangeError);
  assert.deepEqual(nextChunkRange(0, 17, 17), { start: 0, end: 16 });
});

test("파일 이름·크기·수정 시각이 모두 같은 기록 중 최근에 갱신한 것을 찾는다", () => {
  const older = pending({ updatedAt: NOW - 1 });
  const newer = pending();
  const records = [
    older,
    pending({ name: "다른 영상.mp4", updatedAt: NOW + 1 }),
    pending({ size: 1025, updatedAt: NOW + 1 }),
    newer,
    pending({ lastModified: NOW, updatedAt: NOW + 1 }),
  ];
  const order = [...records];
  assert.equal(matchPendingUpload(records, older), newer);
  assert.equal(matchPendingUpload(records, { ...older, name: "없음" }), null);
  assert.equal(matchPendingUpload([], older), null);
  assert.deepEqual(records, order);
});

test("생성부터 일주일이 지난 기록을 만료 처리한다", () => {
  assert.equal(PENDING_UPLOAD_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  const expired = pending({ createdAt: NOW - PENDING_UPLOAD_TTL_MS });
  const old = pending({ createdAt: NOW - PENDING_UPLOAD_TTL_MS - 1 });
  // 갱신이 오래됐어도 세션 자체가 살아 있으면(생성 일주일 미만) 남긴다.
  const fresh = pending({ createdAt: NOW - PENDING_UPLOAD_TTL_MS + 1, updatedAt: NOW - PENDING_UPLOAD_TTL_MS * 2 });
  assert.equal(isPendingUploadExpired(expired, NOW), true);
  assert.equal(isPendingUploadExpired(old, NOW), true);
  assert.equal(isPendingUploadExpired(fresh, NOW), false);
});

test("메모리 저장소는 기록을 저장·갱신·삭제하고 외부 객체 변경과 분리한다", async () => {
  const store = createMemoryPendingUploadStore();
  const record = pending();
  await store.put(record);
  assert.deepEqual(await store.list(), [record]);
  record.uploadedBytes = 100;
  assert.equal((await store.list())[0].uploadedBytes, 0);
  await store.put(record);
  const listed = await store.list();
  assert.equal(listed[0].uploadedBytes, 100);
  listed[0].uploadedBytes = 200;
  assert.equal((await store.list())[0].uploadedBytes, 100);
  assert.deepEqual(await createMemoryPendingUploadStore().list(), []);
  await store.remove(record.id);
  await store.remove(record.id);
  assert.deepEqual(await store.list(), []);
});

test("대기 목록은 만료 기록을 실제로 지우고 생성 시각 순서로 반환한다", async () => {
  const store = createMemoryPendingUploadStore();
  const later = pending({ createdAt: NOW - 1 });
  const earlier = pending({ createdAt: NOW - 2 });
  const expired = pending({ createdAt: NOW - PENDING_UPLOAD_TTL_MS });
  await Promise.all([later, expired, earlier].map((record) => store.put(record)));
  assert.deepEqual(await listPendingUploads(store, CONTEXT, NOW), [earlier, later]);
  assert.deepEqual(await store.list(), [later, earlier]);
});

test("다른 데스크나 사용자의 기록은 목록에서만 제외하고 저장소에 남긴다", async () => {
  const fake = fakeIndexedDb();
  const store = createIndexedDbPendingUploadStore(undefined, fake.factory);
  const mine = pending();
  const otherDesk = pending({ context: "other:user@example.test" });
  const otherUser = pending({ context: "desk:other@example.test" });
  for (const record of [mine, otherDesk, otherUser]) await store.put(record);
  assert.deepEqual(await listPendingUploads(store, CONTEXT, NOW), [mine]);
  const reopened = createIndexedDbPendingUploadStore(undefined, fake.factory);
  assert.deepEqual(await reopened.list(), [mine, otherDesk, otherUser]);
  assert.deepEqual(await listPendingUploads(reopened, otherDesk.context, NOW), [otherDesk]);
  assert.deepEqual(await listPendingUploads(reopened, otherUser.context, NOW), [otherUser]);
});

test("구글 업로드 경로로 시작하는 HTTPS 세션 URL만 신뢰한다", () => {
  assert.equal(isTrustedResumableSessionUrl(SESSION_URL), true);
  assert.equal(isTrustedResumableSessionUrl("https://www.googleapis.com/upload/"), true);
  for (const url of [
    "", "http://www.googleapis.com/upload/drive/v3/files",
    "https://www.googleapis.com/upload", "https://www.googleapis.com/drive/v3/files",
    "https://www.googleapis.com.evil.test/upload/", "https://www.googleapis.com@evil.test/upload/",
    "https://evil.test/upload/", " https://www.googleapis.com/upload/",
  ]) {
    assert.equal(isTrustedResumableSessionUrl(url), false);
  }
});

test("IndexedDB가 없는 Node에서도 가져오기와 기본 저장소 사용이 가능하다", async () => {
  assert.equal(typeof indexedDB, "undefined");
  const store = createIndexedDbPendingUploadStore();
  const record = pending();
  await store.put(record);
  assert.deepEqual(await store.list(), [record]);
  await store.remove(record.id);
  assert.deepEqual(await store.list(), []);
});

test("IndexedDB 열기의 동기 실패는 첫 사용 때 한 번만 시도하고 메모리로 전환한다", async () => {
  let opens = 0;
  const factory = {
    open(name: string, version: number) {
      opens += 1;
      assert.equal(name, "test-pending");
      assert.equal(version, 1);
      throw new Error("열기 실패");
    },
  } as unknown as IDBFactory;
  const store = createIndexedDbPendingUploadStore("test-pending", factory);
  assert.equal(opens, 0);
  const first = pending();
  const second = pending();
  await Promise.all([store.put(first), store.put(second)]);
  assert.equal(opens, 1);
  assert.deepEqual(await store.list(), [first, second]);
  await store.remove(first.id);
  assert.deepEqual(await store.list(), [second]);
  assert.equal(opens, 1);
});

test("IndexedDB 열기의 비동기 오류도 메모리 저장소로 전환한다", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens += 1;
      const request = { onerror: null as (() => void) | null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  } as unknown as IDBFactory;
  const store = createIndexedDbPendingUploadStore(undefined, factory);
  const record = pending();
  await store.put(record);
  assert.deepEqual(await store.list(), [record]);
  await store.remove(record.id);
  assert.deepEqual(await store.list(), []);
  assert.equal(opens, 1);
});

test("IndexedDB 열기 응답이 없으면 메모리로 전환하고 뒤늦게 열린 연결을 닫는다", { timeout: 1000 }, async () => {
  let opens = 0;
  let closes = 0;
  const request = {
    result: { close() { closes += 1; } },
    onsuccess: null as (() => void) | null,
  };
  const factory = {
    open() {
      opens += 1;
      return request;
    },
  } as unknown as IDBFactory;
  const store = createIndexedDbPendingUploadStore(undefined, factory, 20);
  const first = pending();
  const second = pending();
  await Promise.all([store.put(first), store.put(second)]);
  assert.deepEqual(await store.list(), [first, second]);
  request.onsuccess?.();
  assert.equal(closes, 1);
  await store.put({ ...second, uploadedBytes: 512 });
  await store.remove(first.id);
  assert.deepEqual(await store.list(), [{ ...second, uploadedBytes: 512 }]);
  assert.equal(opens, 1);
});

function fakeIndexedDb() {
  const records = new Map<string, PendingUpload>();
  const state = {
    opens: 0,
    created: false,
    abortNext: null as Error | null,
    modes: [] as IDBTransactionMode[],
  };
  const database = {
    objectStoreNames: { contains: (name: string) => name === "uploads" && state.created },
    createObjectStore(name: string, options: IDBObjectStoreParameters) {
      assert.equal(name, "uploads");
      assert.deepEqual(options, { keyPath: "id" });
      state.created = true;
    },
    close() {},
    transaction(name: string, mode: IDBTransactionMode) {
      assert.equal(name, "uploads");
      state.modes.push(mode);
      const transaction = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore(storeName: string) {
          assert.equal(storeName, "uploads");
          return {
            getAll: () => makeRequest([...records.values()].map((record) => ({ ...record }))),
            put: (record: PendingUpload) => {
              assert.equal(mode, "readwrite");
              const copy = { ...record };
              return makeRequest(record.id, () => { records.set(copy.id, copy); });
            },
            delete: (id: string) => {
              assert.equal(mode, "readwrite");
              return makeRequest(undefined, () => { records.delete(id); });
            },
          };
        },
      };
      function makeRequest(result: unknown, commit = () => {}) {
        const request = {
          result,
          error: null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => {
          request.onsuccess?.();
          // 요청 성공과 트랜잭션 완료를 따로 발생시켜 저장 취소를 재현한다.
          queueMicrotask(() => {
            if (state.abortNext) {
              transaction.error = state.abortNext;
              state.abortNext = null;
              transaction.onabort?.();
            } else {
              commit();
              transaction.oncomplete?.();
            }
          });
        });
        return request;
      }
      return transaction;
    },
  };
  const factory = {
    open(name: string, version: number) {
      assert.equal(name, "sharedesk-pending-uploads");
      assert.equal(version, 1);
      state.opens += 1;
      const request = {
        result: database,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (!state.created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, state };
}

test("IndexedDB는 id를 키로 저장·갱신하고 새 저장소에서도 기록을 읽는다", async () => {
  const fake = fakeIndexedDb();
  const store = createIndexedDbPendingUploadStore(undefined, fake.factory);
  const record = pending({ reservationId: "reservation-1" });
  await store.put(record);
  await store.put({ ...record, uploadedBytes: 512 });
  const reopened = createIndexedDbPendingUploadStore(undefined, fake.factory);
  assert.deepEqual(await reopened.list(), [{ ...record, uploadedBytes: 512 }]);
  await reopened.remove(record.id);
  assert.deepEqual(await store.list(), []);
  assert.equal(fake.state.opens, 2);
  assert.deepEqual(fake.state.modes, ["readwrite", "readwrite", "readonly", "readwrite", "readonly"]);
});

test("IndexedDB 요청이 성공해도 트랜잭션이 취소되면 저장 성공으로 반환하지 않는다", async () => {
  const fake = fakeIndexedDb();
  const store = createIndexedDbPendingUploadStore(undefined, fake.factory);
  const failure = new Error("저장 공간 부족");
  fake.state.abortNext = failure;
  await assert.rejects(store.put(pending()), (error) => error === failure);
  assert.deepEqual(await store.list(), []);
  const record = pending();
  await store.put(record);
  assert.deepEqual(await store.list(), [record]);
});

test("상태 조회는 빈 PUT으로 저장 위치·완료·만료를 구분한다", async () => {
  const fake = scriptedXhr([
    { status: 308, range: "bytes=0-1048575" },
    { status: 308 },
    { status: 200, responseText: '{"id":"abc"}' },
    { status: 201, responseText: '{"id":"created"}' },
    { status: 200, responseText: "" },
    { status: 200, responseText: '{"id":123}' },
    { status: 404 },
    { status: 410 },
  ]);
  const statuses = [];
  for (let index = 0; index < 8; index += 1) {
    statuses.push(await queryResumableStatus(SESSION_URL, RESUMABLE_CHUNK_SIZE, fake.xhrFactory));
  }
  assert.deepEqual(statuses, [
    { kind: "incomplete", offset: 1048576 },
    { kind: "incomplete", offset: 0 },
    { kind: "complete", fileId: "abc" },
    { kind: "complete", fileId: "created" },
    { kind: "complete", fileId: null },
    { kind: "complete", fileId: null },
    { kind: "gone" },
    { kind: "gone" },
  ]);
  assertRanges(fake.requests, Array(8).fill(`bytes */${RESUMABLE_CHUNK_SIZE}`));
  assert.ok(fake.requests.every((request) => request.body === null));
});

test("상태 조회의 HTTP 오류와 네트워크 오류는 호출자에게 전달한다", async () => {
  for (const status of [400, 403, 500, 503]) {
    const fake = scriptedXhr([{ status }]);
    await assert.rejects(queryResumableStatus(SESSION_URL, 10, fake.xhrFactory), {
      message: "드라이브 업로드에 실패했습니다",
      status,
    });
  }
  const fake = scriptedXhr([{ event: "error" }]);
  await assert.rejects(queryResumableStatus(SESSION_URL, 10, fake.xhrFactory), {
    message: "네트워크 연결이 끊겼습니다",
  });
});

test("308 뒤에 기록 저장을 기다린 다음 마지막 조각을 보내 200으로 완료한다", async () => {
  const file = new Blob([new Uint8Array(CHUNK).fill(7), "끝"]);
  const fake = scriptedXhr([
    { status: 308, range: `bytes=0-${CHUNK - 1}`, loaded: [CHUNK / 2, CHUNK] },
    { status: 200, responseText: '{"id":"abc"}', loaded: [3] },
  ]);
  const offsets: number[] = [];
  const progress: number[][] = [];
  const result = await uploadResumable({
    sessionUrl: SESSION_URL,
    file,
    chunkSize: CHUNK,
    xhrFactory: fake.xhrFactory,
    onProgress: (transferred, total) => progress.push([transferred, total]),
    onChunkSent: async (offset) => {
      assert.equal(fake.requests.length, 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fake.requests.length, 1);
      offsets.push(offset);
    },
  });
  assert.deepEqual(result, { fileId: "abc" });
  assertRanges(fake.requests, [`bytes 0-${CHUNK - 1}/${file.size}`, `bytes ${CHUNK}-${file.size - 1}/${file.size}`]);
  assert.deepEqual(offsets, [CHUNK]);
  assert.deepEqual(progress, [[CHUNK / 2, file.size], [CHUNK, file.size], [file.size, file.size], [file.size, file.size]]);
  assert.equal(fake.requests[0].body?.size, CHUNK);
  assert.deepEqual(new Uint8Array(await fake.requests[0].body!.arrayBuffer()), new Uint8Array(CHUNK).fill(7));
  assert.equal(await fake.requests[1].body?.text(), "끝");
});

test("저장된 시작 위치부터 보내며 조각 진행량을 파일 전체 기준으로 보고한다", async () => {
  const fake = scriptedXhr([{ status: 201, responseText: '{"id":"abc"}', loaded: [2] }]);
  const progress: number[][] = [];
  const total = CHUNK + 5;
  await uploadResumable({
    sessionUrl: SESSION_URL,
    file: new Blob([new Uint8Array(total)]),
    startOffset: CHUNK,
    xhrFactory: fake.xhrFactory,
    onProgress: (transferred, size) => progress.push([transferred, size]),
  });
  assertRanges(fake.requests, [`bytes ${CHUNK}-${total - 1}/${total}`]);
  assert.deepEqual(progress, [[CHUNK + 2, total], [total, total]]);
  assert.equal(fake.requests[0].body?.size, 5);
});

test("네트워크 실패 뒤 상태를 조회하고 서버에 일부 저장된 위치부터 재개한다", async () => {
  const total = CHUNK * 2 + 3;
  const stored = CHUNK / 2;
  const fake = scriptedXhr([
    { event: "error", loaded: [CHUNK] },
    { status: 308, range: `bytes=0-${stored - 1}` },
    { status: 308, range: `bytes=0-${stored + CHUNK - 1}`, loaded: [CHUNK] },
    { status: 200, responseText: '{"id":"abc"}' },
  ]);
  const offsets: number[] = [];
  const progress: number[][] = [];
  await uploadResumable({
    sessionUrl: SESSION_URL,
    file: new Blob([new Uint8Array(total)]),
    chunkSize: CHUNK,
    xhrFactory: fake.xhrFactory,
    onChunkSent: (offset) => { offsets.push(offset); },
    onProgress: (transferred, size) => progress.push([transferred, size]),
  });
  assertRanges(fake.requests, [
    `bytes 0-${CHUNK - 1}/${total}`,
    `bytes */${total}`,
    `bytes ${stored}-${stored + CHUNK - 1}/${total}`,
    `bytes ${stored + CHUNK}-${total - 1}/${total}`,
  ]);
  assert.equal(fake.requests[1].body, null);
  assert.equal(fake.requests[2].body?.size, CHUNK);
  assert.deepEqual(offsets, [stored, stored + CHUNK]);
  assert.deepEqual(progress, [[CHUNK, total], [stored + CHUNK, total], [total, total]]);
});

test("서버 오류 뒤 Range가 없는 308을 받으면 처음부터 다시 보낸다", async () => {
  const fake = scriptedXhr([
    { status: 503 },
    { status: 308 },
    { status: 201, responseText: '{"id":"abc"}' },
  ]);
  const offsets: number[] = [];
  await uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
    onChunkSent: (offset) => { offsets.push(offset); },
  });
  assertRanges(fake.requests, ["bytes 0-4/5", "bytes */5", "bytes 0-4/5"]);
  assert.deepEqual(offsets, [0]);
});

test("복구 조회에서 이미 완료된 경우 파일 ID만 반환한다", async () => {
  const responseText = '{"id":"abc","name":"완료"}';
  const fake = scriptedXhr([{ event: "error" }, { status: 200, responseText }]);
  const result = await uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
  });
  assert.deepEqual(result, { fileId: "abc" });
  assertRanges(fake.requests, ["bytes 0-4/5", "bytes */5"]);
});

test("복구 조회에서 세션이 만료되면 전송을 멈춘다", async () => {
  for (const status of [404, 410]) {
    const fake = scriptedXhr([{ event: "error" }, { status }]);
    await assert.rejects(uploadResumable({
      sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
    }), { message: "드라이브 업로드 세션이 만료되었습니다" });
    assertRanges(fake.requests, ["bytes 0-4/5", "bytes */5"]);
  }
});

test("조각 전송의 4xx 오류는 재시도 없이 한국어 HTTP 오류로 반환한다", async () => {
  for (const status of [400, 401, 403]) {
    const fake = scriptedXhr([{ status }]);
    await assert.rejects(uploadResumable({
      sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
    }), { name: "Error", message: "드라이브 업로드에 실패했습니다", status });
    assert.equal(fake.requests.length, 1);
  }
});

test("조각 전송에서 세션이 만료되면 영구 오류로 반환한다", async () => {
  for (const status of [404, 410]) {
    const fake = scriptedXhr([{ status }]);
    await assert.rejects(uploadResumable({
      sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
    }), (error) => {
      assert.ok(error instanceof PermanentUploadError);
      assert.equal(error.message, "드라이브 업로드 세션이 만료되었습니다");
      return true;
    });
    assert.equal(fake.requests.length, 1);
  }
});

test("429 뒤 상태를 다시 조회하고 서버에 저장된 위치부터 이어 보낸다", async () => {
  const fake = scriptedXhr([
    { status: 429 },
    { status: 308, range: "bytes=0-1" },
    { status: 200, responseText: '{"id":"abc"}' },
  ]);
  const offsets: number[] = [];
  const result = await uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
    onChunkSent: (offset) => { offsets.push(offset); },
  });
  assert.deepEqual(result, { fileId: "abc" });
  assertRanges(fake.requests, ["bytes 0-4/5", "bytes */5", "bytes 2-4/5"]);
  assert.deepEqual(offsets, [2]);
});

test("같은 조각은 처음 전송 뒤 최대 세 번까지만 다시 보낸다", async () => {
  const fake = scriptedXhr([
    { event: "error" }, { status: 308 },
    { event: "error" }, { status: 308 },
    { event: "error" }, { status: 308 },
    { event: "error" },
  ]);
  await assert.rejects(uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
  }), { message: "네트워크 연결이 끊겼습니다" });
  assertRanges(fake.requests, ["bytes 0-4/5", "bytes */5", "bytes 0-4/5", "bytes */5", "bytes 0-4/5", "bytes */5", "bytes 0-4/5"]);
});

test("복구 조회 자체가 계속 실패해도 세 번 뒤 오류를 반환한다", async () => {
  const fake = scriptedXhr([{ status: 503 }, { event: "error" }, { status: 500 }, { event: "timeout" }]);
  await assert.rejects(uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
  }), { message: "업로드 응답 시간이 초과되었습니다" });
  assertRanges(fake.requests, ["bytes 0-4/5", "bytes */5", "bytes */5", "bytes */5"]);
});

test("조각이 저장되면 다음 조각의 재시도 횟수를 새로 센다", async () => {
  const total = CHUNK + 1;
  const fake = scriptedXhr([
    { event: "error" }, { status: 308 },
    { event: "error" }, { status: 308 },
    { event: "error" }, { status: 308 },
    { status: 308, range: `bytes=0-${CHUNK - 1}` },
    { event: "error" }, { status: 308, range: `bytes=0-${CHUNK - 1}` },
    { status: 200, responseText: '{"id":"abc"}' },
  ]);
  const result = await uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob([new Uint8Array(total)]), chunkSize: CHUNK, xhrFactory: fake.xhrFactory,
  });
  assert.equal(result.fileId, "abc");
  assertRanges(fake.requests, [
    `bytes 0-${CHUNK - 1}/${total}`, `bytes */${total}`,
    `bytes 0-${CHUNK - 1}/${total}`, `bytes */${total}`,
    `bytes 0-${CHUNK - 1}/${total}`, `bytes */${total}`,
    `bytes 0-${CHUNK - 1}/${total}`,
    `bytes ${CHUNK}-${CHUNK}/${total}`, `bytes */${total}`, `bytes ${CHUNK}-${CHUNK}/${total}`,
  ]);
});

test("308에서 저장 위치가 계속 그대로이면 끝없이 전송하지 않는다", async () => {
  const fake = scriptedXhr(Array.from({ length: 4 }, () => ({ status: 308 })));
  await assert.rejects(uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), xhrFactory: fake.xhrFactory,
  }), { message: "드라이브 업로드가 더 진행되지 않습니다" });
  assertRanges(fake.requests, Array(4).fill("bytes 0-4/5"));
});

test("빈 파일은 bytes */0 PUT 한 번으로 완료한다", async () => {
  for (const status of [200, 201]) {
    const fake = scriptedXhr([{ status, responseText: '{"id":"empty"}' }]);
    const result = await uploadResumable({
      sessionUrl: SESSION_URL, file: new Blob([]), xhrFactory: fake.xhrFactory,
    });
    assert.equal(result.fileId, "empty");
    assertRanges(fake.requests, ["bytes */0"]);
    assert.equal(fake.requests[0].body, null);
  }
});

test("시작 위치가 파일 끝이면 조회로 실제 완료 여부를 확인한다", async () => {
  const fake = scriptedXhr([{ status: 200, responseText: '{"id":"abc"}' }]);
  const result = await uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), startOffset: 5, xhrFactory: fake.xhrFactory,
  });
  assert.equal(result.fileId, "abc");
  assertRanges(fake.requests, ["bytes */5"]);
});

test("이어올리기는 먼저 서버 위치를 확인하고 기록 저장 뒤 그 위치부터 보낸다", async () => {
  const fake = scriptedXhr([
    { status: 308, range: "bytes=0-1" },
    { status: 201, responseText: '{"id":"abc"}' },
  ]);
  const offsets: number[] = [];
  const result = await uploadResumable({
    sessionUrl: SESSION_URL, file: new Blob(["hello"]), startOffset: 4,
    verifyOffset: true, xhrFactory: fake.xhrFactory,
    onChunkSent: async (offset) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fake.requests.length, 1);
      offsets.push(offset);
    },
  });
  assert.deepEqual(result, { fileId: "abc" });
  assertRanges(fake.requests, ["bytes */5", "bytes 2-4/5"]);
  assert.deepEqual(offsets, [2]);
});

test("이어올리기 첫 조회에서 완료 또는 만료이면 조각을 보내지 않는다", async () => {
  for (const status of [200, 201, 404, 410]) {
    const fake = scriptedXhr([{ status, responseText: '{"id":"abc"}' }]);
    const upload = uploadResumable({
      sessionUrl: SESSION_URL, file: new Blob(["hello"]),
      verifyOffset: true, xhrFactory: fake.xhrFactory,
    });
    if (status < 300) {
      assert.deepEqual(await upload, { fileId: "abc" });
    } else {
      await assert.rejects(upload, (error) => {
        assert.ok(error instanceof PermanentUploadError);
        assert.equal(error.message, "드라이브 업로드 세션이 만료되었습니다");
        return true;
      });
    }
    assertRanges(fake.requests, ["bytes */5"]);
    assert.equal(fake.requests[0].body, null);
  }
});

test("기록 저장 실패는 전송 오류로 재시도하지 않고 그대로 전달한다", async () => {
  const failure = new Error("기록 저장 실패");
  const fake = scriptedXhr([{ status: 308, range: `bytes=0-${CHUNK - 1}` }]);
  await assert.rejects(uploadResumable({
    sessionUrl: SESSION_URL,
    file: new Blob([new Uint8Array(CHUNK + 1)]),
    chunkSize: CHUNK,
    xhrFactory: fake.xhrFactory,
    onChunkSent: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(fake.requests.length, 1);
});

function pendingFlow(t: TestContext, responses: ScriptedResponse[] = [], postResponses: unknown[] = []) {
  const store = createMemoryPendingUploadStore();
  let records: PendingUpload[] = [];
  const storedAtSend: Promise<PendingUpload[]>[] = [];
  const xhr = scriptedXhr(responses, () => { storedAtSend.push(store.list()); });
  const storedAtPost: Promise<PendingUpload[]>[] = [];
  const postCalls: Array<{ path: string; body: unknown }> = [];
  const post = t.mock.fn<PendingUploadPoster>(async (path, body) => {
    const index = postCalls.length;
    postCalls.push({ path, body });
    storedAtPost.push(store.list());
    assert.ok(index < postResponses.length, "예정에 없는 POST 요청이 발생했습니다");
    const response = postResponses[index];
    if (response instanceof Error) throw response;
    return response;
  });
  const onRecordsChange = t.mock.fn((update: (current: PendingUpload[]) => PendingUpload[]) => {
    records = update(records);
  });
  const heartbeatReservations: string[] = [];
  const stopped: string[] = [];
  t.after(() => {
    // 성공·실패 어느 경로에서도 시작한 예약 갱신을 모두 멈춰야 한다.
    assert.deepEqual(stopped, heartbeatReservations);
  });
  const flow = createPendingUploadFlow({
    store,
    post,
    onRecordsChange,
    xhrFactory: xhr.xhrFactory,
    startHeartbeat: (reservationId) => {
      if (!reservationId) return () => undefined;
      heartbeatReservations.push(reservationId);
      return () => { stopped.push(reservationId); };
    },
  });
  flow.setContext(CONTEXT);
  const file = new File(["hello"], "영상.mp4", { lastModified: NOW - 1000 });
  const record = flow.createRecord({
    sessionUrl: SESSION_URL, reservationId: "reservation", parentId: "root", file,
  });
  return {
    flow, store, xhr, file, record, postCalls, storedAtSend, storedAtPost, onRecordsChange, heartbeatReservations,
    get records() { return records; },
    async seed(...initial: PendingUpload[]) {
      for (const item of initial) await store.put(item);
      records = initial.map((item) => ({ ...item }));
    },
  };
}

test("공용 흐름은 파일 정보와 문맥으로 기록을 만들고 현재 문맥의 살아 있는 기록만 읽는다", async (t) => {
  const startedAt = Date.now();
  assert.equal(pendingUploadContext("/sea/files", "user@example.test"), "sea:user@example.test");
  assert.equal(pendingUploadContext("/files", "user@example.test"), ":user@example.test");
  assert.equal(pendingUploadContext("/sea/files", "other@example.test"), "sea:other@example.test");
  const h = pendingFlow(t);
  const now = h.record.createdAt;
  assert.ok(now >= startedAt && now <= Date.now());
  assert.deepEqual(h.record, {
    id: h.record.id, sessionUrl: SESSION_URL, reservationId: "reservation", parentId: "root",
    context: CONTEXT, name: h.file.name, size: h.file.size, lastModified: h.file.lastModified,
    uploadedBytes: 0, createdAt: now, updatedAt: now,
  });
  assert.match(h.record.id, /^[0-9a-f-]{36}$/);
  assert.equal(h.flow.isTrusted(h.record), true);
  assert.equal(h.flow.createRecord({
    id: "existing-transfer", sessionUrl: SESSION_URL, reservationId: null, parentId: "root", file: h.file,
  }).id, "existing-transfer");
  assert.deepEqual(await h.store.list(), []);
  const other = pending({ context: "other:user@example.test", createdAt: now });
  const expired = pending({ createdAt: now - PENDING_UPLOAD_TTL_MS });
  await h.seed(h.record, other, expired);
  assert.deepEqual(await h.flow.load(), [h.record]);
  assert.deepEqual(await h.store.list(), [h.record, other]);
  assert.equal(h.onRecordsChange.mock.callCount(), 0);
});

test("직접 업로드는 첫 바이트 전에 저장하고 완료 알림 뒤 기록을 지운다", async (t) => {
  const h = pendingFlow(t, [{ status: 201, responseText: '{"id":"abc"}', loaded: [2] }], [{}]);
  const other = pending();
  await h.seed(other);
  const originalPut = h.store.put;
  t.mock.method(h.store, "put", async (record: PendingUpload) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await originalPut(record);
  });
  const progress: number[][] = [];
  const result = await h.flow.uploadDirect(h.record, h.file, (sent, total) => {
    progress.push([sent, total]);
    assert.deepEqual(h.heartbeatReservations, ["reservation"]);
  }, { persist: true });
  assert.equal(result, "abc");
  assertRanges(h.xhr.requests, ["bytes 0-4/5"]);
  assert.deepEqual(await h.storedAtSend[0], [other, { ...h.record, uploadedBytes: 0, updatedAt: h.record.createdAt }]);
  assert.deepEqual(progress, [[2, 5], [5, 5]]);
  assert.deepEqual(h.postCalls, [{
    path: "/api/drive/upload-complete", body: { reservationId: "reservation", fileId: "abc" },
  }]);
  assert.deepEqual(await h.storedAtPost[0], [other, h.record]);
  assert.equal(h.record.uploadedBytes, 5);
  assert.deepEqual(await h.store.list(), [other]);
  assert.deepEqual(h.records, [other]);
});

test("카메라 업로드는 첫 전송과 조각 전송, 완료 알림 뒤에도 기록을 저장하거나 지우지 않는다", async (t) => {
  const h = pendingFlow(t, [
    { status: 308, range: "bytes=0-1" },
    { status: 201, responseText: '{"id":"abc"}' },
  ], [{}]);
  const put = t.mock.method(h.store, "put");
  const remove = t.mock.method(h.store, "remove");
  assert.equal(await h.flow.uploadDirect(h.record, h.file, () => {}, { persist: false }), "abc");
  assertRanges(h.xhr.requests, ["bytes 0-4/5", "bytes 2-4/5"]);
  assert.deepEqual(await Promise.all(h.storedAtSend), [[], []]);
  assert.deepEqual(h.postCalls, [{
    path: "/api/drive/upload-complete", body: { reservationId: "reservation", fileId: "abc" },
  }]);
  assert.deepEqual(await h.storedAtPost[0], []);
  assert.deepEqual(await h.store.list(), []);
  assert.deepEqual(h.records, []);
  assert.equal(put.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(h.onRecordsChange.mock.callCount(), 0);
});

for (const persist of [true, false]) {
  test(`직접 업로드 네트워크 실패는 persist=${persist}에 따라 기록을 남기거나 저장소에 손대지 않는다`, async (t) => {
    const h = pendingFlow(t, [
      { status: 308, range: "bytes=0-1" },
      ...Array.from({ length: 4 }, (): ScriptedResponse => ({ event: "error" })),
    ]);
    const initialRecord = { ...h.record };
    const put = t.mock.method(h.store, "put");
    const remove = t.mock.method(h.store, "remove");
    await assert.rejects(h.flow.uploadDirect(h.record, h.file, () => {}, { persist }), (error) => {
      assert.ok(error instanceof Error && !(error instanceof PermanentUploadError));
      assert.equal(error.message, "네트워크 연결이 끊겼습니다");
      return true;
    });
    assert.deepEqual(await h.storedAtSend[0], persist ? [initialRecord] : []);
    assert.equal(h.record.uploadedBytes, persist ? 2 : 0);
    assert.deepEqual(h.records, persist ? [h.record] : []);
    assert.deepEqual(await h.store.list(), persist ? [h.record] : []);
    assert.equal(put.mock.callCount(), persist ? 2 : 0);
    assert.equal(remove.mock.callCount(), 0);
    if (!persist) {
      assert.deepEqual(await Promise.all(h.storedAtSend), h.xhr.requests.map(() => []));
      assert.equal(h.onRecordsChange.mock.callCount(), 0);
    }
    assert.deepEqual(h.postCalls, []);
  });
}

for (const status of [409, 401]) {
  test(`업로드 완료 알림의 ${status} 응답은 ${status === 409 ? "영구 오류로 기록을 지운다" : "완료 위치를 남긴다"}`, async (t) => {
    const failure = Object.assign(new Error("완료 알림 실패"), { status });
    const h = pendingFlow(t, [{ status: 200, responseText: '{"id":"abc"}' }], [failure]);
    await h.seed(h.record);
    await assert.rejects(h.flow.uploadDirect(h.record, h.file, () => {}, { persist: true }), (error) => {
      if (status === 409) {
        assert.ok(error instanceof PermanentUploadError);
        assert.equal(error.message, failure.message);
      } else {
        assert.equal(error, failure);
      }
      return true;
    });
    assert.deepEqual(h.postCalls, [{
      path: "/api/drive/upload-complete", body: { reservationId: "reservation", fileId: "abc" },
    }]);
    assert.equal(h.record.uploadedBytes, 5);
    assert.deepEqual(await h.storedAtPost[0], [h.record]);
    assert.deepEqual(await h.store.list(), status === 409 ? [] : [h.record]);
    assert.deepEqual(h.records, status === 409 ? [] : [h.record]);
  });
}

test("신뢰하지 않는 재개 URL은 요청 없이 판별하고 기록을 지울 수 있다", async (t) => {
  const h = pendingFlow(t);
  h.record.sessionUrl = "https://example.test/upload/";
  await h.seed(h.record);
  assert.equal(h.flow.isTrusted(h.record), false);
  await h.flow.remove(h.record.id);
  assert.deepEqual(await h.store.list(), []);
  assert.deepEqual(h.records, []);
  assert.deepEqual(h.postCalls, []);
  assert.equal(h.xhr.requests.length, 0);
});

for (const status of [200, 409, 401, 500]) {
  test(`재개 예약 확인의 ${status} 응답은 ${status === 409 ? "기록을 지우고 만료를 알린다" : "기록을 유지한다"}`, async (t) => {
    const response = status === 200 ? {} : Object.assign(new Error("예약 확인 실패"), { status });
    const h = pendingFlow(t, [], [response]);
    await h.seed(h.record);
    if (status === 200 || status === 409) {
      assert.equal(await h.flow.checkReservation(h.record), status === 200 ? "ok" : "reservation-expired");
    } else {
      await assert.rejects(h.flow.checkReservation(h.record), (error) => error === response);
    }
    assert.deepEqual(h.postCalls, [{
      path: "/api/drive/upload-reservation", body: { reservationId: "reservation" },
    }]);
    assert.deepEqual(await h.store.list(), status === 409 ? [] : [h.record]);
    assert.deepEqual(h.records, status === 409 ? [] : [h.record]);
    assert.equal(h.xhr.requests.length, 0);
  });
}

test("예약이 없는 기록은 확인 요청과 heartbeat 없이 전송을 완료한다", async (t) => {
  const h = pendingFlow(t, [{ status: 200, responseText: '{"id":"abc"}' }]);
  h.record.reservationId = null;
  assert.equal(await h.flow.checkReservation(h.record), "ok");
  assert.equal(await h.flow.uploadDirect(h.record, h.file, () => {}, { persist: true }), "abc");
  assert.deepEqual(h.postCalls, []);
  assert.deepEqual(h.heartbeatReservations, []);
  assert.deepEqual(await h.store.list(), []);
});

test("재개는 예약을 확인한 뒤 서버 위치를 조회하고 남은 바이트만 보내 완료한다", async (t) => {
  const h = pendingFlow(t, [
    { status: 308, range: "bytes=0-1" },
    { status: 201, responseText: '{"id":"abc"}', loaded: [1] },
  ], [{}, {}]);
  h.record.uploadedBytes = 4;
  await h.seed(h.record);
  const progress: number[][] = [];
  assert.equal(await h.flow.checkReservation(h.record), "ok");
  assert.equal(await h.flow.resume(h.record, h.file, (sent, total) => progress.push([sent, total])), "abc");
  assertRanges(h.xhr.requests, ["bytes */5", "bytes 2-4/5"]);
  assert.equal(h.xhr.requests[0].body, null);
  assert.equal(await h.xhr.requests[1].body?.text(), "llo");
  assert.equal((await h.storedAtSend[1])[0].uploadedBytes, 2);
  assert.deepEqual(progress, [[3, 5], [5, 5]]);
  assert.deepEqual(h.postCalls, [
    { path: "/api/drive/upload-reservation", body: { reservationId: "reservation" } },
    { path: "/api/drive/upload-complete", body: { reservationId: "reservation", fileId: "abc" } },
  ]);
  assert.deepEqual(await h.store.list(), []);
  assert.deepEqual(h.records, []);
});

test("첫 저장과 진행량 저장이 실패해도 직접 업로드와 완료 알림은 계속한다", async (t) => {
  const h = pendingFlow(t, [
    { status: 308, range: "bytes=0-1" }, { status: 201, responseText: '{"id":"abc"}' },
  ], [{}]);
  const other = pending();
  await h.seed(h.record, other);
  const put = t.mock.method(h.store, "put", async () => { throw new Error("저장 실패"); });
  const progress = t.mock.fn(() => {
    assert.equal(h.records[0].uploadedBytes, 2);
    assert.equal(h.record.uploadedBytes, 2);
  });
  assert.equal(await h.flow.uploadDirect(h.record, h.file, progress, { persist: true }), "abc");
  assert.equal(put.mock.callCount(), 3);
  assert.equal(progress.mock.callCount(), 1);
  assert.equal(h.record.uploadedBytes, 5);
  assert.equal(h.postCalls[0].path, "/api/drive/upload-complete");
  assert.deepEqual(await h.store.list(), [other]);
  assert.deepEqual(h.records, [other]);
});

test("기록 삭제는 저장소가 먼저이며 삭제 실패 시 화면 기록을 바꾸지 않는다", async (t) => {
  const h = pendingFlow(t);
  await h.seed(h.record);
  const before = h.records;
  const failure = new Error("삭제 실패");
  t.mock.method(h.store, "remove", async () => { throw failure; });
  await assert.rejects(h.flow.remove(h.record.id), (error) => error === failure);
  assert.equal(h.records, before);
  assert.deepEqual(await h.store.list(), [h.record]);
  assert.equal(h.onRecordsChange.mock.callCount(), 0);
});

for (const method of ["uploadDirect", "resume"] as const) {
  test(`${method}의 영구 오류는 기록을 지우며 삭제 실패가 원래 오류를 가리지 않는다`, async (t) => {
    for (const removeFails of [false, true]) {
      await t.test(`삭제 실패=${removeFails}`, async (subtest) => {
        const h = pendingFlow(subtest, [{ status: 410 }]);
        await h.seed(h.record);
        if (removeFails) {
          subtest.mock.method(h.store, "remove", async () => { throw new Error("삭제 실패"); });
        }
        const upload = method === "resume"
          ? h.flow.resume(h.record, h.file, () => {})
          : h.flow.uploadDirect(h.record, h.file, () => {}, { persist: true });
        await assert.rejects(upload, (error) => {
          assert.ok(error instanceof PermanentUploadError);
          assert.equal(error.message, "드라이브 업로드 세션이 만료되었습니다");
          return true;
        });
        assert.deepEqual(await h.store.list(), removeFails ? [h.record] : []);
        assert.deepEqual(h.records, removeFails ? [h.record] : []);
      });
    }
  });
}

test("재개 중 네트워크 실패는 원래 기록과 진행량을 남긴다", async (t) => {
  const h = pendingFlow(t, Array.from({ length: 4 }, () => ({ event: "error" })));
  h.record.uploadedBytes = 2;
  await h.seed(h.record);
  await assert.rejects(h.flow.resume(h.record, h.file, () => {}), { message: "네트워크 연결이 끊겼습니다" });
  assertRanges(h.xhr.requests, Array(4).fill("bytes */5"));
  assert.deepEqual(await h.store.list(), [h.record]);
  assert.deepEqual(h.records, [h.record]);
});

test("배선: 이어받기 흐름은 최신 번역의 요청 함수를 ref로 읽는다 — 언어를 바꿔도 오류 문구가 옛 언어로 남지 않게 (#25)", async () => {
  const read = (p: string) => readFile(new URL(p, import.meta.url), "utf8");
  const desktop = await read("../src/app/files/FilesView.tsx");
  const mobile = await read("../src/app/files/MobileFilesView.tsx");
  // 흐름은 한 번만 만든다(??=) — 그 안의 post는 만든 시점의 apiJson이 아니라 ref를 부른다
  assert.match(
    desktop,
    /pendingUploadFlowRef\.current \?\?= createPendingUploadFlow\(\{[\s\S]{0,200}post: \(path, body\) => apiJsonRef\.current\(apiPath\(path\)/,
  );
  assert.match(desktop, /apiJsonRef\.current = apiJson;/);
  assert.match(mobile, /post: \(path, body\) => uploadSessionJsonRef\.current\(path, body\)/);
});
