import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exactSizeUploadStream,
  finishUploadReservation,
  parseUploadContentLength,
  reserveUpload,
  uploadLimitError,
} from "../src/lib/storage-quota";
import {
  MIN_STORAGE_LIMIT_BYTES,
  parseOptionalByteLimit,
  setDeskSettings,
} from "../src/lib/users";
import { getAdapter } from "../src/lib/storage";
import { ROOT_ID } from "../src/lib/storage/types";

test("용량 제한은 null 또는 안전한 바이트 정수만 받는다", () => {
  assert.equal(parseOptionalByteLimit(null), null);
  assert.equal(
    parseOptionalByteLimit(MIN_STORAGE_LIMIT_BYTES),
    MIN_STORAGE_LIMIT_BYTES,
  );
  assert.equal(parseOptionalByteLimit(0), undefined);
  assert.equal(parseOptionalByteLimit(1.5), undefined);
  assert.equal(parseOptionalByteLimit("1024"), undefined);
});

test("한 파일 업로드 제한을 넘는 요청을 판별한다", () => {
  const limit = 10 * 1024 * 1024;
  assert.equal(uploadLimitError(limit, { maxUploadBytes: limit }), null);
  assert.equal(
    uploadLimitError(limit + 1, { maxUploadBytes: limit }),
    "한 번에 올릴 수 있는 파일 크기를 넘었습니다",
  );
  assert.equal(uploadLimitError(Number.NaN, { maxUploadBytes: null }), "파일 크기를 확인해 주세요");
});

test("프록시 업로드는 선언 크기가 없거나 실제 본문과 다르면 거부한다", async () => {
  assert.throws(() => parseUploadContentLength(null), /파일 크기/);
  assert.throws(() => parseUploadContentLength("3.5"), /파일 크기/);
  assert.equal(parseUploadContentLength("3"), 3);

  const exact = exactSizeUploadStream(new Blob(["abc"]).stream(), 3);
  assert.equal(await new Response(exact).text(), "abc");
  await assert.rejects(
    () => new Response(exactSizeUploadStream(new Blob(["abcd"]).stream(), 3)).text(),
    /크기가 일치하지 않습니다/,
  );
  await assert.rejects(
    () => new Response(exactSizeUploadStream(new Blob(["ab"]).stream(), 3)).text(),
    /크기가 일치하지 않습니다/,
  );
});

test("모든 파일 증가 경로가 총용량 검사와 완료 위치 확인을 거친다", async () => {
  const [upload, quickUpload, content, complete] = await Promise.all([
    readFile(new URL("../src/app/api/drive/upload/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/api/drive/quick-link/upload/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/api/drive/content/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/api/drive/upload-complete/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const route of [upload, quickUpload]) {
    assert.match(route, /parseUploadContentLength/);
    assert.match(route, /exactSizeUploadStream/);
  }
  assert.match(content, /growth = Math\.max/);
  assert.match(content, /reserveUpload\(/);
  assert.match(complete, /isDirectChild/);
});

test("한 업로드 파일로 여러 용량 예약을 완료할 수 없다", async () => {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-quota-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await setDeskSettings({ deskStorageLimitBytes: 100 * 1024 * 1024 });
    await assert.rejects(
      () => setDeskSettings({ maxUploadBytes: 200 * 1024 * 1024 }),
      /데스크 전체 제한보다 클 수 없습니다/,
    );
    const adapter = getAdapter();
    const entry = await adapter.upload(
      ROOT_ID,
      "one.txt",
      "text/plain",
      new Blob(["one"]).stream(),
    );
    const first = await reserveUpload({
      userId: "user-1",
      parentId: ROOT_ID,
      name: entry.name,
      size: 3,
    });
    assert.ok(first);
    assert.equal(
      await finishUploadReservation(first, "user-1", entry),
      true,
    );

    const second = await reserveUpload({
      userId: "user-1",
      parentId: ROOT_ID,
      name: entry.name,
      size: 3,
    });
    assert.ok(second);
    await assert.rejects(
      () => finishUploadReservation(second, "user-1", entry),
      /이미 완료 처리한 업로드 파일/,
    );
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
