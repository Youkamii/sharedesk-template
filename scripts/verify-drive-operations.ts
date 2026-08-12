import assert from "node:assert/strict";
import { getAdapter } from "../src/lib/storage";
import { ROOT_ID, StorageError } from "../src/lib/storage/types";

const MIME = "text/plain; charset=utf-8";
const DIRECT_ORIGIN = "http://localhost:3000";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function logStep(name: string, startedAt: number): void {
  const elapsed = Date.now() - startedAt;
  console.log(`PASS  ${name} (${elapsed}ms)`);
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    throw new Error(
      "실제 Drive에 임시 항목을 만들고 지우는 검사입니다. 실행하려면 --live를 붙이세요",
    );
  }
  if (process.env.STORAGE_DRIVER !== "drive") {
    throw new Error("STORAGE_DRIVER=drive인 .env.local에서만 실행할 수 있습니다");
  }
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "DRIVE_ROOT_FOLDER_ID",
  ]) {
    if (!process.env[name]) throw new Error(`${name}이(가) 없습니다`);
  }

  const adapter = getAdapter();
  const runName = `sharedesk-operations-test-${Date.now()}`;
  const createdIds: string[] = [];

  try {
    let startedAt = Date.now();
    const probe = await adapter.createFolder(ROOT_ID, runName);
    createdIds.push(probe.id);
    const source = await adapter.createFolder(probe.id, "source");
    createdIds.push(source.id);
    const target = await adapter.createFolder(probe.id, "target");
    createdIds.push(target.id);
    const rootEntries = await adapter.list(ROOT_ID);
    assert.ok(rootEntries.some((entry) => entry.id === probe.id));
    logStep("폴더 생성과 루트 목록", startedAt);

    startedAt = Date.now();
    const serverBody = Buffer.from("ShareDesk server upload probe\n", "utf8");
    const uploaded = await adapter.upload(
      source.id,
      "server-upload.txt",
      MIME,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(serverBody);
          controller.close();
        },
      }),
    );
    createdIds.push(uploaded.id);
    const sourceAfterUpload = await adapter.list(source.id);
    assert.ok(sourceAfterUpload.some((entry) => entry.id === uploaded.id));
    logStep("서버 업로드와 폴더 목록", startedAt);

    startedAt = Date.now();
    const downloaded = await adapter.download(uploaded.id);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(await readAll(downloaded.stream), serverBody);
    logStep("전체 다운로드", startedAt);

    startedAt = Date.now();
    await adapter.rename(uploaded.id, "renamed.txt");
    const renamed = (await adapter.list(source.id)).find(
      (entry) => entry.id === uploaded.id,
    );
    assert.ok(renamed);
    assert.equal(renamed.name, "renamed.txt");
    assert.ok(renamed.version, "이동에 쓸 목록 ETag가 없습니다");
    logStep("이름 변경", startedAt);

    startedAt = Date.now();
    await adapter.move(renamed.id, target.id, renamed.version);
    assert.ok(!(await adapter.list(source.id)).some((entry) => entry.id === renamed.id));
    assert.ok((await adapter.list(target.id)).some((entry) => entry.id === renamed.id));
    logStep("폴더 간 이동", startedAt);

    startedAt = Date.now();
    const directBody = Buffer.from("ShareDesk direct upload probe\n", "utf8");
    const session = await adapter.createUploadSession(
      target.id,
      "direct-upload.txt",
      MIME,
      directBody.byteLength,
      DIRECT_ORIGIN,
    );
    assert.equal(session.mode, "direct");
    const directResponse = await fetch(session.url, {
      method: "PUT",
      headers: { "Content-Type": MIME, Origin: DIRECT_ORIGIN },
      body: directBody,
    });
    assert.equal(directResponse.ok, true, `직행 PUT HTTP ${directResponse.status}`);
    const direct = (await adapter.list(target.id)).find(
      (entry) => entry.name === "direct-upload.txt",
    );
    assert.ok(direct);
    createdIds.push(direct.id);
    const directDownload = await adapter.download(direct.id);
    assert.deepEqual(await readAll(directDownload.stream), directBody);
    logStep("브라우저 직행 업로드와 다운로드", startedAt);

    startedAt = Date.now();
    await adapter.remove(renamed.id);
    assert.ok(!(await adapter.list(target.id)).some((entry) => entry.id === renamed.id));
    const firstTrashEntry = (await adapter.listTrash()).find(
      (entry) => entry.id === renamed.id,
    );
    assert.ok(firstTrashEntry);
    const restored = await adapter.restore(renamed.id);
    assert.equal(restored.id, renamed.id);
    assert.ok((await adapter.list(target.id)).some((entry) => entry.id === renamed.id));
    await adapter.remove(renamed.id);
    const purgeEntry = (await adapter.listTrash()).find(
      (entry) => entry.id === renamed.id,
    );
    assert.ok(purgeEntry);
    await adapter.purge(renamed.id, purgeEntry.version);
    await assert.rejects(
      adapter.getEntry(renamed.id),
      (error: unknown) => error instanceof StorageError && error.code === "NOT_FOUND",
    );
    logStep("휴지통 이동, 복원, 완전 삭제", startedAt);
  } finally {
    let cleanupFailed = false;
    for (const id of [...createdIds].reverse()) {
      try {
        await adapter.remove(id);
      } catch (error) {
        if (!(error instanceof StorageError && error.code === "NOT_FOUND")) {
          cleanupFailed = true;
          continue;
        }
      }
      try {
        const entry = (await adapter.listTrash()).find((item) => item.id === id);
        if (entry) await adapter.purge(id, entry.version);
      } catch (error) {
        if (!(error instanceof StorageError && error.code === "NOT_FOUND")) {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) {
      throw new Error(
        "일부 테스트 항목을 정리하지 못했습니다. Drive의 sharedesk-operations-test-* 폴더를 확인해 주세요.",
      );
    }
    if (createdIds.length > 0) {
      console.log("정리: 테스트 파일과 폴더를 역순으로 완전 삭제했습니다.");
    }
  }

  console.log("\n실제 Drive 기본 작업 검증을 모두 통과했습니다.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "검증에 실패했습니다");
  process.exitCode = 1;
});
