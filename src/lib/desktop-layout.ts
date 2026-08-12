import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import {
  type Entry,
  type StorageAdapter,
  StorageError,
} from "@/lib/storage/types";

const FILE_VERSION = 2;
const MAX_WRITE_ATTEMPTS = 4;
const MAX_FOLDER_LIST_ATTEMPTS = 3;
const LEGACY_PLANE_SIZE = 600;
const ICON_WIDTH = 88;
const ICON_HEIGHT = 94;
const GRID_COLUMNS = 6;
const GRID_X = 12;
const GRID_Y = 10;
const GRID_STEP_X = 96;
const GRID_STEP_Y = 104;
// 라우트가 중복 검증하지 않고 assertUpdates/assertId에 위임하므로 내부 상수다.
const MAX_LAYOUT_COORDINATE = 1_000_000;
const MAX_LAYOUT_UPDATES = 256;
const MAX_LAYOUT_ID_LENGTH = 1024;
// 목록에 없는 항목의 좌표는 이 유예가 지난 뒤에만 정리한다 — 목록 스냅숏이
// 요청 시작 시점의 것이라, 방금 생긴 항목의 산 좌표를 지우는 사고를 막는다.
const PRUNE_GRACE_MS = 10 * 60 * 1000;
// Drive 폴더 검증(getEntry) 결과를 잠깐 기억해 같은 폴더 재조회 왕복을 줄인다.
// 경로 id가 재사용될 수 있는 local 폴더는 캐시하지 않고 매번 identity를 확인한다.
const FOLDER_CACHE_MS = 60_000;

export interface LayoutPosition {
  x: number;
  y: number;
  version: number;
}

export interface LayoutSnapshot {
  folderIdentity: string;
  revision: number;
  positions: Record<string, LayoutPosition>;
}

export interface LayoutUpdate {
  entryId: string;
  expectedVersion: number;
  x: number;
  y: number;
}

interface StoredPosition extends LayoutPosition {
  updatedAt: string;
  updatedBy: string;
}

interface LayoutFile {
  version: 2;
  folderKey: string;
  rev: number;
  items: Record<string, StoredPosition>;
}

export type FolderListingWithLayout = {
  entries: Entry[];
  layout: LayoutSnapshot | null;
  layoutError?: string;
};

class FolderIdentityConflict extends StorageError {
  constructor() {
    super("CONFLICT", "폴더가 삭제된 뒤 같은 경로에 새로 만들어졌습니다");
  }
}

// 같은 서버 인스턴스에서는 폴더별 쓰기를 직렬화하고, 인스턴스 사이는 저장소 CAS로 조정한다.
const writeChains = new Map<string, Promise<void>>();

// 인스턴스 캐시: 마지막으로 읽거나 쓴 레이아웃 파일의 내용+버전.
// 저장 경로는 이 캐시를 신뢰하고 바로 조건부 쓰기(CAS)를 날린다 — 낡았으면
// 저장소가 CONFLICT로 알려주므로 그때만 다시 읽는다. 웜 상태의 저장이
// "읽기 2왕복 + 쓰기 1왕복"에서 "쓰기 1왕복"으로 줄어드는 핵심이다.
const fileCache = new Map<string, { file: LayoutFile; version: string }>();
const folderCache = new Map<string, { entry: Entry; exp: number }>();

function emptyItems<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyFile(folderKey: string): LayoutFile {
  return {
    version: FILE_VERSION,
    folderKey,
    rev: 0,
    items: emptyItems(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_LAYOUT_COORDINATE
  );
}

function isLegacyCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalize(raw: unknown, folderKey: string): LayoutFile {
  if (raw === null) return emptyFile(folderKey);
  if (
    !isRecord(raw) ||
    (raw.version !== 1 && raw.version !== FILE_VERSION) ||
    !isRecord(raw.items)
  ) {
    throw new StorageError("UPSTREAM", "레이아웃 상태가 손상되었습니다");
  }
  if (raw.folderKey !== folderKey) {
    throw new StorageError(
      "UPSTREAM",
      "레이아웃 상태가 현재 폴더와 일치하지 않습니다",
    );
  }

  const items = emptyItems<StoredPosition>();
  for (const [key, value] of Object.entries(raw.items)) {
    if (
      !isRecord(value) ||
      !(raw.version === 1 ? isLegacyCoordinate(value.x) : isCoordinate(value.x)) ||
      !(raw.version === 1 ? isLegacyCoordinate(value.y) : isCoordinate(value.y)) ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1
    ) {
      continue;
    }
    const x = value.x as number;
    const y = value.y as number;
    items[key] = {
      x: raw.version === 1 ? Math.round(x * LEGACY_PLANE_SIZE) : x,
      y: raw.version === 1 ? Math.round(y * LEGACY_PLANE_SIZE) : y,
      version: value.version as number,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : "",
    };
  }

  return {
    version: FILE_VERSION,
    folderKey,
    rev:
      Number.isSafeInteger(raw.rev) && (raw.rev as number) >= 0
        ? (raw.rev as number)
        : 0,
    items,
  };
}

function stateFileName(folderKey: string): string {
  const hash = createHash("sha256").update(folderKey).digest("hex");
  return `desktop-layout-${hash.slice(0, 32)}.json`;
}

function assertFolder(entry: Entry): void {
  if (!entry.isFolder) {
    throw new StorageError("BAD_ID", "폴더가 아닙니다");
  }
}

function assertId(id: string): void {
  if (!id || id.length > MAX_LAYOUT_ID_LENGTH) {
    throw new StorageError("BAD_ID", "잘못된 id입니다");
  }
}

function assertFolderIdentity(identity: string): void {
  if (!identity || identity.length > MAX_LAYOUT_ID_LENGTH) {
    throw new StorageError("BAD_ID", "잘못된 폴더 식별값입니다");
  }
}

function assertUpdates(updates: LayoutUpdate[]): void {
  if (!Array.isArray(updates) || updates.length > MAX_LAYOUT_UPDATES) {
    throw new StorageError("BAD_ID", "레이아웃 변경이 너무 많습니다");
  }
  const ids = new Set<string>();
  for (const update of updates) {
    if (
      !update ||
      typeof update.entryId !== "string" ||
      update.entryId.length === 0 ||
      update.entryId.length > MAX_LAYOUT_ID_LENGTH ||
      !Number.isSafeInteger(update.expectedVersion) ||
      update.expectedVersion < 0 ||
      !isCoordinate(update.x) ||
      !isCoordinate(update.y) ||
      ids.has(update.entryId)
    ) {
      throw new StorageError("BAD_ID", "잘못된 레이아웃 변경입니다");
    }
    ids.add(update.entryId);
  }
}

async function getFolder(
  adapter: StorageAdapter,
  folderId: string,
): Promise<Entry> {
  const hit = folderCache.get(folderId);
  // Drive id는 다시 쓰이지 않지만 local id는 경로라서 폴더를 지우고 같은 이름으로
  // 다시 만들면 새 파일 시스템 identity가 같은 id를 쓴다. local 항목은 캐시하지
  // 않아 새 layoutKey가 별도 상태 파일과 쓰기 큐를 사용하게 한다.
  if (
    hit &&
    hit.exp > Date.now() &&
    !hit.entry.layoutKey.startsWith("local:")
  ) {
    return hit.entry;
  }
  if (hit) folderCache.delete(folderId);
  const entry = await adapter.getEntry(folderId);
  assertFolder(entry);
  folderCache.set(folderId, { entry, exp: Date.now() + FOLDER_CACHE_MS });
  if (folderCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of folderCache) if (v.exp < now) folderCache.delete(k);
  }
  return entry;
}

// 목록에 없는 항목의 좌표 정리 — 단, 최근에 갱신된 좌표는 유예한다.
function pruneDeadItems(
  file: LayoutFile,
  entries: Entry[],
): { file: LayoutFile; changed: boolean } {
  const live = new Set(entries.map((entry) => entry.layoutKey));
  const items = emptyItems<StoredPosition>();
  const now = Date.now();
  let changed = false;
  for (const [key, position] of Object.entries(file.items)) {
    if (live.has(key)) {
      items[key] = position;
      continue;
    }
    const updatedAt = Date.parse(position.updatedAt);
    if (Number.isFinite(updatedAt) && now - updatedAt < PRUNE_GRACE_MS) {
      items[key] = position;
      continue;
    }
    changed = true;
  }
  return { file: { ...file, items }, changed };
}

function rectanglesOverlap(
  a: Pick<LayoutPosition, "x" | "y">,
  b: Pick<LayoutPosition, "x" | "y">,
): boolean {
  return (
    a.x < b.x + ICON_WIDTH &&
    a.x + ICON_WIDTH > b.x &&
    a.y < b.y + ICON_HEIGHT &&
    a.y + ICON_HEIGHT > b.y
  );
}

// 좌표가 없는 항목에 빈 칸을 배치한다. 기존 좌표는 절대 지우지 않는다 —
// entries가 요청 시작 시점의 스냅숏이라, 프루닝은 pruneDeadItems(유예)만 한다.
function assignStablePositions(
  file: LayoutFile,
  entries: Entry[],
): { file: LayoutFile; changed: boolean } {
  const current: LayoutFile = { ...file, items: { ...file.items } };
  let changed = false;
  const occupied = Object.values(current.items);
  const updatedAt = new Date().toISOString();
  let slotIndex = 0;

  for (const entry of entries) {
    if (current.items[entry.layoutKey]) continue;
    let position: { x: number; y: number } | null = null;
    while (!position) {
      const col = slotIndex % GRID_COLUMNS;
      const row = Math.floor(slotIndex / GRID_COLUMNS);
      slotIndex++;
      const candidate = {
        x: GRID_X + col * GRID_STEP_X,
        y: GRID_Y + row * GRID_STEP_Y,
      };
      if (candidate.y > MAX_LAYOUT_COORDINATE) {
        throw new StorageError("UPSTREAM", "레이아웃 공간이 부족합니다");
      }
      if (!occupied.some((item) => rectanglesOverlap(candidate, item))) {
        position = candidate;
      }
    }
    const stored: StoredPosition = {
      ...position,
      version: 1,
      updatedAt,
      updatedBy: "system",
    };
    current.items[entry.layoutKey] = stored;
    occupied.push(stored);
    changed = true;
  }

  return { file: current, changed };
}

function toSnapshot(file: LayoutFile, entries: Entry[]): LayoutSnapshot {
  const positions = emptyItems<LayoutPosition>();
  for (const entry of entries) {
    const position = file.items[entry.layoutKey];
    if (!position) continue;
    positions[entry.layoutKey] = {
      x: position.x,
      y: position.y,
      version: position.version,
    };
  }
  return { folderIdentity: file.folderKey, revision: file.rev, positions };
}

function toUnfilteredSnapshot(file: LayoutFile): LayoutSnapshot {
  const positions = emptyItems<LayoutPosition>();
  for (const [key, position] of Object.entries(file.items)) {
    positions[key] = {
      x: position.x,
      y: position.y,
      version: position.version,
    };
  }
  return { folderIdentity: file.folderKey, revision: file.rev, positions };
}

async function readFileVersioned(
  adapter: StorageAdapter,
  fileName: string,
  folderKey: string,
): Promise<{ file: LayoutFile; version: string | null }> {
  const cached = fileCache.get(fileName);
  const state = await adapter.readStateVersioned<LayoutFile>(
    fileName,
    cached ? { version: cached.version, value: cached.file } : undefined,
  );
  const file = normalize(state.value, folderKey);
  if (state.version) fileCache.set(fileName, { file, version: state.version });
  else fileCache.delete(fileName);
  return { file, version: state.version };
}

// CAS 성공 시 캐시를 응답 버전으로 잇는다. 버전을 모르면 캐시를 비워 다음
// 읽기가 저장소를 보게 한다.
async function casAndCache(
  adapter: StorageAdapter,
  fileName: string,
  draft: LayoutFile,
  expectedVersion: string | null,
): Promise<void> {
  const newVersion = await adapter.compareAndSwapState(
    fileName,
    draft,
    expectedVersion,
  );
  if (newVersion) fileCache.set(fileName, { file: draft, version: newVersion });
  else fileCache.delete(fileName);
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(key, tail);
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return run;
}

function resolveUpdateTargets(entries: Entry[], updates: LayoutUpdate[]) {
  const layoutKeyById = new Map(
    entries.map((entry) => [entry.id, entry.layoutKey] as const),
  );
  const seenLayoutKeys = new Set<string>();
  return updates.map((update) => {
    const layoutKey = layoutKeyById.get(update.entryId);
    if (!layoutKey) {
      // 다른 폴더에 있는지까지 알려주지 않고 현재 위치에서는 없는 것으로 답한다.
      throw new StorageError("NOT_FOUND", "현재 폴더에 없는 항목입니다");
    }
    if (seenLayoutKeys.has(layoutKey)) {
      throw new StorageError("BAD_ID", "같은 항목을 두 번 변경할 수 없습니다");
    }
    seenLayoutKeys.add(layoutKey);
    return { update, layoutKey };
  });
}

async function assertCurrentFolderIdentity(
  adapter: StorageAdapter,
  folderId: string,
  expectedLayoutKey: string,
): Promise<void> {
  const current = await getFolder(adapter, folderId);
  if (current.layoutKey !== expectedLayoutKey) {
    throw new FolderIdentityConflict();
  }
}

export async function getLayoutSnapshot(
  folderId: string,
): Promise<LayoutSnapshot> {
  assertId(folderId);
  const adapter = getAdapter();
  const folder = await getFolder(adapter, folderId);
  const fileName = stateFileName(folder.layoutKey);
  const { file } = await readFileVersioned(adapter, fileName, folder.layoutKey);
  return toUnfilteredSnapshot(file);
}

async function getLayoutSnapshotForVerifiedEntries(
  adapter: StorageAdapter,
  folderId: string,
  folder: Entry,
  entries: Entry[],
): Promise<LayoutSnapshot> {
  const fileName = stateFileName(folder.layoutKey);

  return enqueue(fileName, async () => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      await assertCurrentFolderIdentity(adapter, folderId, folder.layoutKey);
      const { file: before, version: storageVersion } =
        await readFileVersioned(adapter, fileName, folder.layoutKey);
      const pruned = pruneDeadItems(before, entries);
      const assigned = assignStablePositions(pruned.file, entries);
      if (!pruned.changed && !assigned.changed) {
        return toSnapshot(assigned.file, entries);
      }

      const draft: LayoutFile = {
        ...assigned.file,
        rev: before.rev + 1,
      };
      try {
        await assertCurrentFolderIdentity(adapter, folderId, folder.layoutKey);
        await casAndCache(adapter, fileName, draft, storageVersion);
        return toSnapshot(draft, entries);
      } catch (e) {
        if (e instanceof FolderIdentityConflict) throw e;
        if (!(e instanceof StorageError) || e.code !== "CONFLICT") throw e;
        fileCache.delete(fileName);
        if (attempt + 1 === MAX_WRITE_ATTEMPTS) {
          throw new StorageError(
            "CONFLICT",
            "레이아웃이 계속 변경되어 초기 배치를 저장하지 못했습니다",
          );
        }
      }
    }
    throw new StorageError("CONFLICT", "레이아웃을 저장하지 못했습니다");
  });
}

// 호출자가 읽은 항목과 같은 폴더 실체에서 발급받은 identity를 반드시 함께 보낸다.
export async function getLayoutSnapshotForEntries(
  folderId: string,
  entries: Entry[],
  expectedFolderIdentity: string,
): Promise<LayoutSnapshot> {
  assertId(folderId);
  assertFolderIdentity(expectedFolderIdentity);
  const adapter = getAdapter();
  const folder = await getFolder(adapter, folderId);
  if (folder.layoutKey !== expectedFolderIdentity) {
    throw new FolderIdentityConflict();
  }
  return getLayoutSnapshotForVerifiedEntries(
    adapter,
    folderId,
    folder,
    entries,
  );
}

// list와 folderIdentity를 한 흐름에서 읽고 앞뒤 identity를 검증한다. local 경로가
// 조회 도중 재사용되면 옛 entries를 버리고 전체 목록부터 다시 읽는다.
export async function getFolderListingWithLayout(
  folderId: string,
): Promise<FolderListingWithLayout> {
  assertId(folderId);
  const adapter = getAdapter();
  for (let attempt = 0; attempt < MAX_FOLDER_LIST_ATTEMPTS; attempt++) {
    const folder = await getFolder(adapter, folderId);
    const entries = await adapter.list(folderId);
    try {
      await assertCurrentFolderIdentity(adapter, folderId, folder.layoutKey);
      const layout = await getLayoutSnapshotForVerifiedEntries(
        adapter,
        folderId,
        folder,
        entries,
      );
      return { entries, layout };
    } catch (error) {
      if (error instanceof FolderIdentityConflict) {
        if (attempt + 1 < MAX_FOLDER_LIST_ATTEMPTS) continue;
        throw error;
      }
      try {
        await assertCurrentFolderIdentity(adapter, folderId, folder.layoutKey);
      } catch (identityError) {
        if (!(identityError instanceof FolderIdentityConflict)) {
          throw identityError;
        }
        if (attempt + 1 < MAX_FOLDER_LIST_ATTEMPTS) continue;
        throw identityError;
      }
      // 배치 상태가 손상돼도, identity가 검증된 현재 폴더의 파일 작업은 계속한다.
      return {
        entries,
        layout: null,
        layoutError: "공유 배치를 불러오지 못했습니다",
      };
    }
  }
  throw new FolderIdentityConflict();
}

export async function updateLayout(
  folderId: string,
  updates: LayoutUpdate[],
  actorId: string,
  expectedFolderIdentity: string,
): Promise<LayoutSnapshot> {
  assertId(folderId);
  assertUpdates(updates);
  assertFolderIdentity(expectedFolderIdentity);
  const adapter = getAdapter();
  const folder = await getFolder(adapter, folderId);
  if (folder.layoutKey !== expectedFolderIdentity) {
    throw new FolderIdentityConflict();
  }
  const fileName = stateFileName(folder.layoutKey);

  return enqueue(fileName, async () => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      // local 폴더 id는 경로라서 큐를 기다리는 동안 같은 이름의 새 폴더가 그 id를
      // 다시 쓸 수 있다. 캡처한 identity가 여전히 같은지 시도마다 확인한 뒤에만
      // 그 identity에서 만든 상태 파일을 읽고 쓴다.
      await assertCurrentFolderIdentity(
        adapter,
        folderId,
        expectedFolderIdentity,
      );

      // 캐시가 있으면 읽기 왕복 없이 바로 조건부 쓰기로 간다. 캐시가 낡았으면
      // CAS가 CONFLICT를 돌려주고, 그때 캐시를 비우고 다시 읽는다.
      let before: LayoutFile;
      let storageVersion: string | null;
      const cached = fileCache.get(fileName);
      const fromCache = cached !== undefined;
      if (cached) {
        before = normalize(cached.file, folder.layoutKey);
        storageVersion = cached.version;
      } else {
        ({ file: before, version: storageVersion } = await readFileVersioned(
          adapter,
          fileName,
          folder.layoutKey,
        ));
      }

      // 요청자가 보낸 id를 바로 레이아웃 키로 바꾸면 존재하지 않거나 다른 폴더에
      // 있는 항목도 현재 폴더 상태에 심을 수 있다. 큐에서 차례가 온 뒤 실제 직속
      // 목록을 읽고, CAS 재시도 때도 다시 읽어 대기 중 이동된 항목을 저장하지 않는다.
      const entries = updates.length > 0 ? await adapter.list(folderId) : [];
      const targets = resolveUpdateTargets(entries, updates);

      // 버전 불일치가 "캐시가 낡아서"일 수 있다 (다른 인스턴스가 먼저 썼고,
      // 클라이언트는 그 최신 버전을 들고 온 경우). 캐시 기준 판정으로는 정직한
      // 요청을 거부하게 되므로, 신선한 읽기로 한 번 더 확인한 뒤에만 거부한다.
      let mismatch = false;
      for (const { update, layoutKey } of targets) {
        const version = before.items[layoutKey]?.version ?? 0;
        if (version !== update.expectedVersion) {
          mismatch = true;
          break;
        }
      }
      if (mismatch) {
        if (fromCache) {
          fileCache.delete(fileName);
          continue;
        }
        throw new StorageError(
          "CONFLICT",
          "아이콘 위치가 다른 사용자에 의해 변경되었습니다",
        );
      }

      if (updates.length === 0) return toUnfilteredSnapshot(before);

      // 목록을 읽는 사이 같은 local 경로가 새 폴더로 바뀔 수도 있다. 실제 쓰기
      // 직전에도 요청자가 본 폴더 identity가 유지되는지 한 번 더 확인한다.
      await assertCurrentFolderIdentity(
        adapter,
        folderId,
        expectedFolderIdentity,
      );

      const items = { ...before.items };
      const updatedAt = new Date().toISOString();
      for (const { update, layoutKey } of targets) {
        items[layoutKey] = {
          x: update.x,
          y: update.y,
          version: update.expectedVersion + 1,
          updatedAt,
          updatedBy: actorId,
        };
      }
      const draft: LayoutFile = {
        ...before,
        rev: before.rev + 1,
        items,
      };

      try {
        await casAndCache(adapter, fileName, draft, storageVersion);
        return toUnfilteredSnapshot(draft);
      } catch (e) {
        if (!(e instanceof StorageError) || e.code !== "CONFLICT") throw e;
        fileCache.delete(fileName);
        if (attempt + 1 === MAX_WRITE_ATTEMPTS) {
          throw new StorageError(
            "CONFLICT",
            "레이아웃이 계속 변경되어 저장하지 못했습니다",
          );
        }
      }
    }

    throw new StorageError("CONFLICT", "레이아웃을 저장하지 못했습니다");
  });
}
