// 데스크 간 복사의 순회 규칙. 서버는 파일 하나만 담당하므로 폴더를 훑어
// 작업 목록을 만들고 하나씩 부르는 일은 받는 쪽 화면이 한다.
//
// 목록 길이가 곧 반복 상한이라 종료가 구조적으로 보장된다. 다만 같은 항목에서
// 실패-재시도가 돌면 인덱스가 전진하지 않으므로 항목별 재시도 상한을 둔다.

export interface RemoteEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
}

export interface RemoteManifest {
  kind: "file" | "folder";
  name: string;
  size: number | null;
  entries: RemoteEntry[] | null;
}

/** 옮길 파일 하나. parentPath는 링크 루트를 기준으로 한 폴더 경로다. */
export interface ImportTask {
  // 링크 루트 자체가 파일이면 null이다.
  entryId: string | null;
  name: string;
  size: number | null;
  parentPath: string[];
}

export interface ImportPlan {
  rootName: string;
  isFolder: boolean;
  tasks: ImportTask[];
  // 만들어야 할 폴더 경로. 파일이 하나도 없는 폴더도 구조를 지키려면 만들어야
  // 하는데, 파일 작업만 훑으면 그런 폴더가 조용히 사라진다.
  folders: string[][];
  // 훑다가 상한에 걸려 목록이 잘렸는지. 조용히 일부만 옮기지 않으려고 알린다.
  truncated: boolean;
}

// 악의적이거나 망가진 데스크가 끝없이 깊은 트리를 주는 것을 막는다.
export const MAX_DEPTH = 12;
export const MAX_TASKS = 2000;
export const MAX_ATTEMPTS = 3;
// 파일 개수만으로는 순회가 끝나지 않는다. 파일이 하나도 없고 폴더만 있는
// 트리에서는 tasks가 계속 0이라 MAX_TASKS가 발동하지 않고, 레벨마다 폴더 수가
// 곱해져 호출이 폭발한다. 폴더를 펼친 횟수 자체에 상한을 둔다.
export const MAX_FOLDER_READS = 300;

export interface PlanDeps {
  // entryId가 null이면 링크 루트를 읽는다.
  readManifest(entryId: string | null): Promise<RemoteManifest | null>;
}

/**
 * 보내는 데스크의 목록을 훑어 옮길 파일을 평탄한 순서로 늘어놓는다.
 * 폴더 구조는 각 작업의 parentPath에 남는다.
 */
export async function planDeskImport(deps: PlanDeps): Promise<ImportPlan | null> {
  const root = await deps.readManifest(null);
  if (!root) return null;

  if (root.kind === "file") {
    return {
      rootName: root.name,
      isFolder: false,
      tasks: [{ entryId: null, name: root.name, size: root.size, parentPath: [] }],
      folders: [],
      truncated: false,
    };
  }

  const tasks: ImportTask[] = [];
  const folders: string[][] = [];
  let folderReads = 0;
  let truncated = false;

  // 너비 우선으로 훑는다 — 얕은 파일이 먼저 도착해 진행이 눈에 보인다.
  let frontier: { entries: RemoteEntry[]; path: string[] }[] = [
    { entries: root.entries ?? [], path: [] },
  ];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: { entries: RemoteEntry[]; path: string[] }[] = [];
    let exhausted = false;
    for (const level of frontier) {
      for (const entry of level.entries) {
        if (tasks.length >= MAX_TASKS || folderReads >= MAX_FOLDER_READS) {
          truncated = true;
          exhausted = true;
          break;
        }
        if (!entry.isFolder) {
          tasks.push({
            entryId: entry.id,
            name: entry.name,
            size: entry.size,
            parentPath: level.path,
          });
          continue;
        }
        const path = [...level.path, entry.name];
        // 파일이 없는 폴더도 구조를 지키려면 만들어야 한다.
        folders.push(path);
        folderReads += 1;
        const child = await deps.readManifest(entry.id);
        // 하위 폴더를 못 읽으면 그 가지만 건너뛴다. 전체를 실패로 만들지 않는다.
        if (!child) {
          truncated = true;
          continue;
        }
        // 빈 폴더는 더 펼칠 것이 없다. next에 넣으면 다음 깊이가 있는 것처럼
        // 보여 truncated가 잘못 켜진다.
        if (child.entries && child.entries.length > 0) {
          next.push({ entries: child.entries, path });
        }
      }
      if (exhausted) break;
    }
    if (next.length > 0 && depth + 1 >= MAX_DEPTH) truncated = true;
    frontier = next;
  }

  return { rootName: root.name, isFolder: true, tasks, folders, truncated };
}

export interface RunDeps {
  // 이미 있으면 그 폴더를 쓰고, 없으면 만든다. 만들어진 폴더 id를 준다.
  ensureFolder(name: string, parentId: string): Promise<string>;
  // 파일 하나를 받아 저장한다. 실패하면 예외를 던진다.
  importFile(task: ImportTask, parentId: string): Promise<void>;
}

export interface RunHandlers {
  onProgress?(done: number, total: number, task: ImportTask): void;
  // 재시도 상한까지 실패한 항목.
  onFailure?(task: ImportTask, error: unknown): void;
  // 중단 요청. true를 주면 다음 항목으로 넘어가지 않는다.
  shouldStop?(): boolean;
}

export interface RunResult {
  copied: number;
  failed: ImportTask[];
  stopped: boolean;
}

/**
 * 계획된 작업을 순서대로 옮긴다. 폴더는 필요할 때 만들고, 항목별로 최대
 * MAX_ATTEMPTS번 시도한 뒤 실패로 넘긴다 — 한 파일 때문에 전체가 멈추지 않는다.
 */
export async function runDeskImport(
  plan: ImportPlan,
  rootParentId: string,
  deps: RunDeps,
  handlers: RunHandlers = {},
): Promise<RunResult> {
  const failed: ImportTask[] = [];
  // 경로 → 이 데스크에서의 폴더 id.
  const folderIds = new Map<string, string>([["", rootParentId]]);
  let copied = 0;

  // 링크 루트가 폴더면 그 이름으로 감싸는 폴더를 먼저 만든다. 여기서 실패하면
  // 아무 데도 넣을 수 없으므로 전부 실패로 돌려준다 — 예외로 터뜨리면 화면이
  // 몇 개까지 옮겼는지조차 알 수 없다.
  if (plan.isFolder) {
    try {
      folderIds.set("", await deps.ensureFolder(plan.rootName, rootParentId));
    } catch (error) {
      for (const task of plan.tasks) {
        failed.push(task);
        handlers.onFailure?.(task, error);
      }
      return { copied: 0, failed, stopped: false };
    }
  }

  // 파일이 없는 폴더도 구조를 지키려면 먼저 만들어 둔다. 여기서 실패한 가지는
  // 그 아래 파일이 개별 실패로 잡히므로 통째로 중단하지 않는다.
  for (const path of plan.folders) {
    if (handlers.shouldStop?.()) {
      return { copied, failed, stopped: true };
    }
    try {
      await resolveFolder(path, folderIds, deps);
    } catch {
      // 아래 파일 처리에서 다시 시도되고, 거기서 실패로 기록된다.
    }
  }

  for (const task of plan.tasks) {
    if (handlers.shouldStop?.()) {
      return { copied, failed, stopped: true };
    }

    let parentId: string;
    try {
      parentId = await resolveFolder(task.parentPath, folderIds, deps);
    } catch (error) {
      failed.push(task);
      handlers.onFailure?.(task, error);
      continue;
    }

    let lastError: unknown = null;
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt += 1) {
      try {
        await deps.importFile(task, parentId);
        done = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (done) {
      copied += 1;
      handlers.onProgress?.(copied, plan.tasks.length, task);
    } else {
      failed.push(task);
      handlers.onFailure?.(task, lastError);
    }
  }

  return { copied, failed, stopped: false };
}

async function resolveFolder(
  path: string[],
  folderIds: Map<string, string>,
  deps: RunDeps,
): Promise<string> {
  let key = "";
  let parentId = folderIds.get("");
  if (parentId === undefined) throw new Error("루트 폴더를 찾지 못했습니다");
  for (const name of path) {
    key = key ? `${key}/${name}` : name;
    const known = folderIds.get(key);
    if (known !== undefined) {
      parentId = known;
      continue;
    }
    parentId = await deps.ensureFolder(name, parentId);
    folderIds.set(key, parentId);
  }
  return parentId;
}
