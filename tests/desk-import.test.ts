import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_ATTEMPTS,
  MAX_DEPTH,
  MAX_FOLDER_READS,
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

function planOf(
  tasks: ImportTask[],
  isFolder = true,
  folders: string[][] = [],
): ImportPlan {
  return { rootName: "묶음", isFolder, tasks, folders, truncated: false };
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
test("받기 창이 사이드바와 작업표시줄에 연결돼 있다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /import DeskImportWindow from "\.\/DeskImportWindow"/);
  // 사이드바 항목(#11)
  assert.match(
    source,
    /onClick=\{openDeskImportWindow\}[\s\S]{0,160}다른 데스크에서 받기/,
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

// --- 적대 리뷰에서 잡힌 결함들의 재발 방지 ---

// 파일 개수만 세면 폴더만 있는 트리에서 상한이 발동하지 않는다. 레벨마다
// 폴더 수가 곱해져 호출이 폭발했다.
test("파일이 하나도 없고 폴더만 갈라지는 트리도 반드시 끝난다", async () => {
  let reads = 0;
  const plan = await planDeskImport({
    readManifest: async () => {
      reads += 1;
      // 매 응답이 하위 폴더 5개를 내놓고 파일은 하나도 주지 않는다.
      return folder(
        "폭발",
        Array.from({ length: 5 }, (_, index) =>
          folderEntry(`d${reads}-${index}`, `${reads}-${index}`),
        ),
      );
    },
  });
  assert.ok(plan);
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.truncated, true);
  // 상한이 없으면 5^12까지 갔다.
  assert.ok(
    reads <= MAX_FOLDER_READS + 1,
    `폴더 펼치기가 상한을 넘었다: ${reads}`,
  );
});

test("빈 폴더도 만들 목록에 들어가고, 그것 때문에 잘렸다고 하지 않는다", async () => {
  const tree: Record<string, RemoteManifest> = {
    root: folder("묶음", [folderEntry("d1", "빈폴더"), fileEntry("f1", "a.txt")]),
    d1: folder("빈폴더", []),
  };
  const plan = await planDeskImport({
    readManifest: async (entryId) => tree[entryId ?? "root"] ?? null,
  });
  assert.ok(plan);
  // 파일이 없어도 폴더는 만들어져야 구조가 유지된다.
  assert.deepEqual(plan.folders, [["빈폴더"]]);
  assert.deepEqual(plan.tasks.map((task) => task.name), ["a.txt"]);
  // 빈 폴더는 더 펼칠 것이 없으므로 잘림 경고를 켜지 않는다.
  assert.equal(plan.truncated, false);
});

test("계획에 담긴 빈 폴더는 파일이 없어도 실제로 만들어진다", async () => {
  const deps = recordingDeps(async () => {});
  const result = await runDeskImport(
    planOf([], true, [["빈폴더"], ["빈폴더", "더빈폴더"]]),
    "root",
    deps,
  );
  assert.equal(result.copied, 0);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(deps.created, [
    "root/묶음",
    "folder-1/빈폴더",
    "folder-2/더빈폴더",
  ]);
});

// 루트 폴더 생성이 try 밖이라 예외가 그대로 터졌고, 화면은 몇 개까지 옮겼는지도
// 알 수 없었다.
test("루트 폴더를 못 만들면 예외 대신 전부 실패로 보고한다", async () => {
  const failures: string[] = [];
  const deps: RunDeps = {
    ensureFolder: async () => {
      throw new Error("이미 있음");
    },
    importFile: async () => {
      throw new Error("여기까지 오면 안 된다");
    },
  };
  const result = await runDeskImport(
    planOf([
      { entryId: "f1", name: "a.txt", size: 1, parentPath: [] },
      { entryId: "f2", name: "b.txt", size: 1, parentPath: [] },
    ]),
    "root",
    deps,
    { onFailure: (task) => failures.push(task.name) },
  );
  assert.equal(result.copied, 0);
  assert.deepEqual(result.failed.map((task) => task.name), ["a.txt", "b.txt"]);
  assert.deepEqual(failures, ["a.txt", "b.txt"]);
});

test("받기 창은 폴더가 이미 있으면 그 폴더에 합친다", async () => {
  const source = await readFile(
    new URL("../src/app/files/DeskImportWindow.tsx", import.meta.url),
    "utf8",
  );
  // mkdir 409를 그냥 실패로 두면 같은 링크를 두 번 받을 수 없다.
  assert.match(source, /isFolderExistsConflict/);
  assert.match(source, /matchExistingFolder/);
  // 창이 사라지면 복사 루프도 멈춰야 진행률 없이 계속 받는 일이 없다.
  assert.match(source, /return\s*\(\)\s*=>\s*\{\s*stopRef\.current = true;/);
  // 확인이 도는 동안 주소가 바뀌면 그 결과는 버린다.
  assert.match(source, /linkRef\.current !== target/);
});

// 폴더 읽기 상한은 폴더를 펼치는 비용에만 걸려야 한다. 파일까지 버리면 같은
// 트리라도 목록에서 파일이 폴더보다 뒤에 있으면 사라진다.
test("폴더 읽기 상한에 걸려도 같은 목록의 파일은 담는다", async () => {
  const many = [
    ...Array.from({ length: MAX_FOLDER_READS + 20 }, (_, index) =>
      folderEntry(`d${index}`, `폴더${index}`),
    ),
    fileEntry("f1", "뒤에있는파일.txt"),
  ];
  const plan = await planDeskImport({
    readManifest: async (entryId) =>
      entryId === null ? folder("많음", many) : folder("빈", []),
  });
  assert.ok(plan);
  // 폴더 뒤에 있어도 파일은 계획에 들어간다.
  assert.deepEqual(
    plan.tasks.map((task) => task.name),
    ["뒤에있는파일.txt"],
  );
  assert.equal(plan.truncated, true);
});
