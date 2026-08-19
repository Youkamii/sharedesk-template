// 폴더 드래그 업로드. 브라우저의 FileSystemEntry API로 드롭한 트리를 훑어
// {폴더 목록, 파일 목록}으로 펴고, 서버에는 부모 폴더부터 순서대로 만든 뒤
// 파일을 제자리에 올린다. 트리를 계획으로 바꾸는 부분은 순수 함수로 떼어
// 단위 테스트가 붙는다 (tests/files-move-ui.test.ts).

// path는 드롭 지점 기준 상대 경로이고 자기 이름까지 포함한다.
// 예) 폴더 a 안의 b.txt → { kind: "file", path: ["a", "b.txt"] }
export type DroppedItem<F = File> =
  | { readonly kind: "file"; readonly path: readonly string[]; readonly file: F }
  | { readonly kind: "folder"; readonly path: readonly string[] }
  // 수집 단계에서 이미 올릴 수 없다고 판단한 항목 (숨김 이름 등). 개수만 센다.
  | { readonly kind: "skipped"; readonly path: readonly string[] };

export interface PlannedUploadFile<F = File> {
  readonly file: F;
  readonly folderPath: readonly string[];
}

export interface FolderUploadPlan<F = File> {
  // 부모가 항상 자식보다 앞에 오도록 정렬된 폴더 경로 목록.
  readonly folders: readonly string[][];
  readonly files: readonly PlannedUploadFile<F>[];
  // 점(.)으로 시작해 건너뛴 항목 수. 서버(assertUserName)가 어차피 거부한다.
  readonly skipped: number;
}

const PATH_SEPARATOR = "\u0000";

export function folderPathKey(path: readonly string[]): string {
  return path.join(PATH_SEPARATOR);
}

export function isHiddenName(name: string): boolean {
  return name.trim().startsWith(".");
}

export function hasHiddenSegment(path: readonly string[]): boolean {
  return path.some(isHiddenName);
}

// 수집한 트리를 "만들 폴더 + 올릴 파일"로 바꾼다. 파일이 들어 있는 폴더는
// 명시적으로 수집되지 않았더라도 조상까지 전부 계획에 넣는다.
export function planFolderUpload<F>(
  items: readonly DroppedItem<F>[],
): FolderUploadPlan<F> {
  const folders: string[][] = [];
  const seen = new Set<string>();
  const files: PlannedUploadFile<F>[] = [];
  let skipped = 0;

  const addFolder = (path: readonly string[]) => {
    for (let depth = 1; depth <= path.length; depth += 1) {
      const slice = path.slice(0, depth);
      const key = folderPathKey(slice);
      if (seen.has(key)) continue;
      seen.add(key);
      folders.push(slice);
    }
  };

  for (const item of items) {
    if (!item.path.length) continue;
    if (item.kind === "skipped" || hasHiddenSegment(item.path)) {
      skipped += 1;
      continue;
    }
    if (item.kind === "folder") {
      addFolder(item.path);
      continue;
    }
    const folderPath = item.path.slice(0, -1);
    addFolder(folderPath);
    files.push({ file: item.file, folderPath });
  }

  return { folders, files, skipped };
}

// 만들어진 폴더 id 표를 보고 실제로 올릴 수 있는 파일만 고른다.
// 상위 폴더 생성이 실패하면 그 아래 파일은 올릴 곳이 없으므로 막힌 것으로 센다.
export function resolveUploadTargets<F>(
  files: readonly PlannedUploadFile<F>[],
  folderIds: ReadonlyMap<string, string>,
): { ready: { file: F; parentId: string }[]; blocked: number } {
  const ready: { file: F; parentId: string }[] = [];
  let blocked = 0;
  for (const item of files) {
    const parentId = folderIds.get(folderPathKey(item.folderPath));
    if (parentId === undefined) {
      blocked += 1;
      continue;
    }
    ready.push({ file: item.file, parentId });
  }
  return { ready, blocked };
}

// mkdir이 409를 돌려준 경우만 "이미 있는 폴더"로 보고 병합을 시도한다.
export function isFolderExistsConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { status?: unknown; body?: unknown };
  if (record.status === 409) return true;
  const body = record.body;
  if (!body || typeof body !== "object") return false;
  return (body as { code?: unknown }).code === "CONFLICT";
}

// 409를 받았을 때 목록에서 같은 이름의 폴더를 찾아 그 안으로 병합한다.
// 같은 이름의 파일 때문에 난 충돌이면 못 찾고 null이 되어 호출부가 실패로 남긴다.
export function matchExistingFolder(
  entries: readonly { id: string; name: string; isFolder: boolean }[],
  name: string,
): string | null {
  // Windows·macOS 파일시스템은 대소문자를 무시해 "docs"가 있으면 "Docs"도
  // 이미-존재(409)가 난다 — 병합 대조도 같은 기준(정규화+소문자)으로 한다.
  const fold = (value: string) => value.trim().normalize("NFC").toLowerCase();
  const wanted = fold(name);
  const found = entries.find(
    (entry) => entry.isFolder && fold(entry.name) === wanted,
  );
  return found ? found.id : null;
}

// 드롭 순간에 동기로 불러야 한다 — 핸들러가 끝나면 DataTransferItemList가 비워진다.
// 디렉터리가 하나도 없으면 null을 돌려주고, 호출부는 기존 파일 업로드 경로를 쓴다.
export function droppedDirectoryEntries(
  transfer: DataTransfer | null | undefined,
): FileSystemEntry[] | null {
  const items = transfer?.items;
  if (!items || !items.length) return null;
  const entries: FileSystemEntry[] = [];
  let hasDirectory = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (!entry) continue;
    entries.push(entry);
    if (entry.isDirectory) hasDirectory = true;
  }
  return hasDirectory ? entries : null;
}

function readEntryBatch(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries((batch) => resolve([...batch]), reject);
  });
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

// readEntries는 한 번에 최대 100개만 준다 — 빈 배열이 올 때까지 계속 읽어야 한다.
async function readAllEntries(
  directory: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await readEntryBatch(reader);
    if (!batch.length) return all;
    all.push(...batch);
  }
}

export async function collectDroppedTree(
  roots: readonly FileSystemEntry[],
): Promise<DroppedItem[]> {
  const items: DroppedItem[] = [];

  const walk = async (entry: FileSystemEntry, parentPath: string[]) => {
    const path = [...parentPath, entry.name];
    if (entry.isFile) {
      // 점으로 시작하는 이름은 어차피 서버가 거부하므로 File 핸들도 만들지 않는다.
      if (isHiddenName(entry.name)) {
        items.push({ kind: "skipped", path });
        return;
      }
      items.push({
        kind: "file",
        path,
        file: await readEntryFile(entry as FileSystemFileEntry),
      });
      return;
    }
    if (!entry.isDirectory) return;
    // 숨김 폴더는 만들 수 없으니 안까지 훑지 않는다 — 건너뛴 항목 1개로 센다.
    if (isHiddenName(entry.name)) {
      items.push({ kind: "skipped", path });
      return;
    }
    items.push({ kind: "folder", path });
    const children = await readAllEntries(entry as FileSystemDirectoryEntry);
    for (const child of children) await walk(child, path);
  };

  for (const root of roots) await walk(root, []);
  return items;
}
