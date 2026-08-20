import assert from "node:assert/strict";
import test from "node:test";
import { uploadLimitError } from "../src/lib/storage-quota";
import {
  MIN_STORAGE_LIMIT_BYTES,
  parseOptionalByteLimit,
} from "../src/lib/users";

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
