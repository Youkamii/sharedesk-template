import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_ATTEMPTS,
  MAX_DEPTH,
  MAX_TASKS,
  planDeskImport,
  runDeskImport,
  type ImportPlan,
  type ImportTask,
  type RemoteManifest,
  type RunDeps,
} from "../src/lib/client/desk-import";

function folder(name: string, entries: RemoteManifest["entries"]): RemoteManifest {
  return { kind: "folder", name, size: null, entries };
}

function fileEntry(id: string, name: string, size = 1) {
  return { id, name, isFolder: false, size };
}

function folderEntry(id: string, name: string) {
  return { id, name, isFolder: true, size: null };
}

test("파일 링크는 작업 하나로 계획된다", async () => {
  const plan = await planDeskImport({
    readManifest: async (entryId) => {
      assert.equal(entryId, null);
      return { kind: "file", name: "note.txt", size: 12, entries: null };
    },
  });
  assert.ok(plan);
  assert.equal(plan.isFolder, false);
  assert.equal(plan.truncated, false);
  assert.deepEqual(plan.tasks, [
    { entryId: null, name: "note.txt", size: 12, parentPath: [] },
  ]);
});

test("폴더 링크는 하위 파일까지 평탄화하고 폴더 경로를 남긴다", async () => {
  const tree: Record<string, RemoteManifest> = {
    root: folder("묶음", [fileEntry("f1", "a.txt"), folderEntry("d1", "안쪽")]),
    d1: folder("안쪽", [fileEntry("f2", "deep.txt"), folderEntry("d2", "더안쪽")]),
    d2: folder("더안쪽", [fileEntry("f3", "deeper.txt")]),
  };
  const plan = await planDeskImport({
    readManifest: async (entryId) => tree[entryId ?? "root"] ?? null,
  });
  assert.ok(plan);
  assert.equal(plan.isFolder, true);
  assert.equal(plan.truncated, false);
  assert.deepEqual(
    plan.tasks.map((task) => [task.name, task.parentPath.join("/")]),
    [
      ["a.txt", ""],
      ["deep.txt", "안쪽"],
      ["deeper.txt", "안쪽/더안쪽"],
    ],
  );
});

test("읽지 못한 하위 폴더는 그 가지만 건너뛰고 잘렸음을 알린다", async () => {
  const plan = await planDeskImport({
    readManifest: async (entryId) => {
      if (entryId === null) {
        return folder("묶음", [fileEntry("f1", "ok.txt"), folderEntry("bad", "깨진")]);
      }
      return null;
    },
  });
  assert.ok(plan);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.tasks.map((task) => task.name), ["ok.txt"]);
});

test("끝없이 깊은 트리는 깊이 상한에서 멈추고 잘렸음을 알린다", async () => {
  let reads = 0;
  const plan = await planDeskImport({
    readManifest: async () => {
      reads += 1;
      // 언제나 하위 폴더를 하나 더 내놓는 무한 트리.
      return folder("끝없음", [folderEntry(`d${reads}`, `${reads}`)]);
    },
  });
  assert.ok(plan);
  assert.equal(plan.truncated, true);
  assert.ok(reads <= MAX_DEPTH + 1, `읽기 횟수가 상한을 넘었다: ${reads}`);
});

test("항목이 너무 많으면 상한에서 끊고 잘렸음을 알린다", async () => {
  const many = Array.from({ length: MAX_TASKS + 50 }, (_, index) =>
    fileEntry(`f${index}`, `${index}.txt`),
  );
  const plan = await planDeskImport({
    readManifest: async () => folder("많음", many),
  });
  assert.ok(plan);
  assert.equal(plan.tasks.length, MAX_TASKS);
  assert.equal(plan.truncated, true);
});

function planOf(tasks: ImportTask[], isFolder = true): ImportPlan {
  return { rootName: "묶음", isFolder, tasks, truncated: false };
}

function recordingDeps(
  importFile: RunDeps["importFile"],
): RunDeps & { created: string[] } {
  const created: string[] = [];
  let counter = 0;
  return {
    created,
    async ensureFolder(name, parentId) {
      created.push(`${parentId}/${name}`);
      counter += 1;
      return `folder-${counter}`;
    },
    importFile,
  };
}

test("폴더는 필요한 만큼만 만들고 같은 경로를 두 번 만들지 않는다", async () => {
  const saved: string[] = [];
  const deps = recordingDeps(async (task, parentId) => {
    saved.push(`${parentId}:${task.name}`);
  });
  const result = await runDeskImport(
    planOf([
      { entryId: "f1", name: "a.txt", size: 1, parentPath: ["안쪽"] },
      { entryId: "f2", name: "b.txt", size: 1, parentPath: ["안쪽"] },
      { entryId: "f3", name: "c.txt", size: 1, parentPath: [] },
    ]),
    "root",
    deps,
  );
  assert.equal(result.copied, 3);
  assert.deepEqual(result.failed, []);
  // 링크 루트 폴더 1개 + "안쪽" 1개. "안쪽"은 재사용되어 다시 만들지 않는다.
  assert.deepEqual(deps.created, ["root/묶음", "folder-1/안쪽"]);
  assert.deepEqual(saved, [
    "folder-2:a.txt",
    "folder-2:b.txt",
    "folder-1:c.txt",
  ]);
});

test("한 파일이 실패해도 나머지는 계속 옮긴다", async () => {
  const attempts = new Map<string, number>();
  const failures: string[] = [];
  const deps = recordingDeps(async (task) => {
    const count = (attempts.get(task.name) ?? 0) + 1;
    attempts.set(task.name, count);
    if (task.name === "bad.txt") throw new Error("실패");
  });
  const result = await runDeskImport(
    planOf(
      [
        { entryId: "f1", name: "good.txt", size: 1, parentPath: [] },
        { entryId: "f2", name: "bad.txt", size: 1, parentPath: [] },
        { entryId: "f3", name: "also-good.txt", size: 1, parentPath: [] },
      ],
      false,
    ),
    "root",
    deps,
    { onFailure: (task) => failures.push(task.name) },
  );
  assert.equal(result.copied, 2);
  assert.deepEqual(result.failed.map((task) => task.name), ["bad.txt"]);
  assert.deepEqual(failures, ["bad.txt"]);
  // 실패한 항목만 상한까지 다시 시도한다.
  assert.equal(attempts.get("bad.txt"), MAX_ATTEMPTS);
  assert.equal(attempts.get("good.txt"), 1);
});

test("몇 번 실패해도 상한 안에서 성공하면 옮긴 것으로 센다", async () => {
  let tries = 0;
  const deps = recordingDeps(async () => {
    tries += 1;
    if (tries < MAX_ATTEMPTS) throw new Error("일시적 실패");
  });
  const result = await runDeskImport(
    planOf([{ entryId: "f1", name: "flaky.txt", size: 1, parentPath: [] }], false),
    "root",
    deps,
  );
  assert.equal(result.copied, 1);
  assert.deepEqual(result.failed, []);
});

test("중단을 요청하면 다음 항목으로 넘어가지 않는다", async () => {
  const saved: string[] = [];
  let stop = false;
  const deps = recordingDeps(async (task) => {
    saved.push(task.name);
    stop = true;
  });
  const result = await runDeskImport(
    planOf(
      [
        { entryId: "f1", name: "one.txt", size: 1, parentPath: [] },
        { entryId: "f2", name: "two.txt", size: 1, parentPath: [] },
      ],
      false,
    ),
    "root",
    deps,
    { shouldStop: () => stop },
  );
  assert.equal(result.stopped, true);
  assert.equal(result.copied, 1);
  assert.deepEqual(saved, ["one.txt"]);
});

// 화면 연결이 빠지면 서버 경로가 멀쩡해도 사용자가 쓸 방법이 없다.
test("받기 창이 추가기능 메뉴와 작업표시줄에 연결돼 있다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /import DeskImportWindow from "\.\/DeskImportWindow"/);
  // 추가기능 메뉴 항목
  assert.match(
    source,
    /role="menuitem" onClick=\{openDeskImportWindow\}[\s\S]{0,160}다른 데스크에서 받기/,
  );
  // 창 렌더와 작업표시줄 복원 버튼
  assert.match(source, /<DeskImportWindow[\s\S]{0,900}onActivate=\{focusDeskImportWindow\}/);
  assert.match(source, /onClick=\{focusDeskImportWindow\}/);
  // 최소화한 창을 다시 띄우려면 활성 창 계산에도 들어가야 한다.
  assert.match(
    source,
    /deskImportWindow && !deskImportWindow\.minimized\s*\?\s*deskImportWindow\.z/,
  );
  // 받은 파일은 바탕화면에 도착한다.
  assert.match(source, /parentId=\{ROOT_ID\}/);
  // 올릴 수 있는 역할에게만 보인다.
  assert.match(source, /allowUpload && deskImportWindow/);
});

test("받기 창은 서버를 거쳐 목록과 파일을 가져온다", async () => {
  const source = await readFile(
    new URL("../src/app/files/DeskImportWindow.tsx", import.meta.url),
    "utf8",
  );
  // 브라우저가 다른 데스크로 직접 요청하면 CORS에 막히므로 서버를 거친다.
  assert.match(source, /"\/api\/drive\/import\/manifest"/);
  assert.match(source, /`\/api\/drive\/import\?parentId=\$\{encodeURIComponent\(/);
  assert.match(source, /"\/api\/drive\/mkdir"/);
  // 보내는 데스크 주소(link 상태값)로 브라우저가 직접 요청하면 CORS에 막히고,
  // 서버가 하던 주소 검증도 건너뛰게 된다.
  assert.doesNotMatch(source, /fetch\(\s*link\b/);
  // 세션이 끊기면 로그인 화면으로 보낸다.
  assert.match(source, /status === 401[\s\S]{0,80}router\.replace\("\/"\)/);
});
