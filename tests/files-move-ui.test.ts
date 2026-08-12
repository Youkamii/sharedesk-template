import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyMoveFailure,
  confirmedMoveEntries,
  dragTerminalAction,
  foldersAwaitingIdle,
  isDragPointer,
  needsDetachedFolderRefresh,
  shouldRetryFolderReconciliation,
  windowsContainingFolder,
} from "../src/lib/client/file-move";

test("파일 이동의 명확한 4xx 거부만 즉시 원복 대상으로 분류한다", () => {
  const conflict = Object.assign(new Error("다른 사용자가 먼저 옮겼습니다"), {
    status: 409,
  });

  assert.equal(classifyMoveFailure({ status: 400 }), "definitive");
  assert.equal(classifyMoveFailure({ status: 401 }), "definitive");
  assert.equal(classifyMoveFailure({ status: 404 }), "definitive");
  assert.equal(classifyMoveFailure(conflict), "definitive");
});

test("응답 유실과 처리 여부가 모호한 HTTP 오류는 실제 목록을 다시 확인한다", () => {
  assert.equal(classifyMoveFailure(new TypeError("Failed to fetch")), "uncertain");
  assert.equal(classifyMoveFailure({ status: 403 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 408 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 422 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 429 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 499 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 500 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: 503 }), "uncertain");
  assert.equal(classifyMoveFailure({ status: "409" }), "uncertain");
  assert.equal(classifyMoveFailure(null), "uncertain");
});

test("드래그는 시작한 포인터만 끝낼 수 있고 취소는 저장하지 않는다", () => {
  assert.equal(isDragPointer(7, 7), true);
  assert.equal(isDragPointer(7, 8), false);
  assert.equal(dragTerminalAction("pointerup", false, true), "ignore");
  assert.equal(dragTerminalAction("pointerup", true, false), "cleanup");
  assert.equal(dragTerminalAction("pointerup", true, true), "commit");
  assert.equal(dragTerminalAction("pointercancel", true, true), "discard");
});

test("겹친 이동이 있으면 폴더가 빌 때까지 기다리고 그 사이 변경되면 다시 조회한다", () => {
  const affectedFolderIds = ["source", "target", "target"];
  const pendingCounts = new Map([
    ["target", 2],
    ["unrelated", 1],
  ]);
  const startedVersions = new Map([
    ["source", 3],
    ["target", 5],
  ]);
  const currentVersions = new Map(startedVersions);

  assert.deepEqual(
    foldersAwaitingIdle(affectedFolderIds, pendingCounts),
    ["target"],
  );
  assert.equal(
    shouldRetryFolderReconciliation(
      affectedFolderIds,
      pendingCounts,
      startedVersions,
      currentVersions,
    ),
    true,
  );

  pendingCounts.delete("target");
  assert.equal(
    shouldRetryFolderReconciliation(
      affectedFolderIds,
      pendingCounts,
      startedVersions,
      currentVersions,
    ),
    false,
  );

  currentVersions.set("source", 4);
  assert.equal(
    shouldRetryFolderReconciliation(
      affectedFolderIds,
      pendingCounts,
      startedVersions,
      currentVersions,
    ),
    true,
  );
});

test("열린 화면이 없는 원본이나 대상 폴더는 별도 GET으로 확인한다", () => {
  assert.equal(needsDetachedFolderRefresh(0), true);
  assert.equal(needsDetachedFolderRefresh(1), false);
  assert.equal(needsDetachedFolderRefresh(2), false);
});

test("로컬 이동처럼 응답 ID가 바뀌어도 낙관적 항목을 중복으로 남기지 않는다", () => {
  const entries = [
    { id: "optimistic-old", name: "이동 항목" },
    { id: "confirmed-new", name: "오래된 응답" },
    { id: "other", name: "다른 항목" },
  ];
  const confirmed = { id: "confirmed-new", name: "이동 항목" };

  assert.deepEqual(
    confirmedMoveEntries(entries, "optimistic-old", confirmed),
    [{ id: "other", name: "다른 항목" }, confirmed],
  );
});

test("옮긴 폴더와 하위 폴더를 연 창을 함께 찾는다", () => {
  const windows = [
    {
      id: "moved-folder-window",
      path: [{ id: "root" }, { id: "moved-folder" }],
    },
    {
      id: "descendant-window",
      path: [
        { id: "root" },
        { id: "moved-folder" },
        { id: "child-folder" },
      ],
    },
    {
      id: "unrelated-window",
      path: [{ id: "root" }, { id: "other-folder" }],
    },
  ];

  assert.deepEqual(
    windowsContainingFolder(windows, "moved-folder").map((item) => item.id),
    ["moved-folder-window", "descendant-window"],
  );
});

test("레이아웃 저장은 폴더 식별값을 보내고 닫힌 창의 이전 요청을 무효화한다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /folderIdentity: node\.folderIdentity/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(
    source,
    /function cancelScopeRequests[\s\S]*?cancelLayoutSaves\(scopeId\);[\s\S]*?\n  }/,
  );
  assert.match(
    source,
    /if \(!isActiveSave\(key, node\) \|\| isAbortError\(error\)\) return;/,
  );
});
