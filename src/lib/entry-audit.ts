import { after } from "next/server";
import type { SessionInfo } from "@/lib/auth";
import { createSerialQueue } from "@/lib/serial-queue";
import { getAdapter } from "@/lib/storage";
import type { Entry } from "@/lib/storage/types";

// 항목별 내력(#14) — "이 파일을 누가 올렸고, 누가 받아 갔는지".
// activity.json은 데스크 전체의 최근 200건이라 파일 하나의 내력을 물어볼 수
// 없다(이름으로만 적고, 오래되면 밀려난다). 여기서는 layoutKey를 열쇠로 삼아
// 항목마다 따로 담는다 — layoutKey는 이름이 바뀌어도 따라가는 신원이다.
// 관례: readStateVersioned → normalize → compareAndSwapState.

const FILE = "entry-audit.json";
const MAX_ATTEMPTS = 4;
// 항목 수 상한. 넘치면 마지막 손댄 시각이 오래된 것부터 버린다.
const MAX_ENTRIES = 4_000;
// 항목 하나가 기억하는 최근 다운로드 수.
const MAX_DOWNLOADS = 20;
const MAX_KEY_LENGTH = 1024;
const MAX_NAME_LENGTH = 120;
// 항목 하나가 기억하는 최근 변경(수정·이름 변경·이동·삭제·복원) 수(#16 C-1).
const MAX_CHANGES = 20;
// 항목 이름은 저장소 이름 상한(assertValidName 255자)까지 그대로 둔다.
const MAX_ENTRY_NAME_LENGTH = 255;
// 세션 userId — 명단 id(구글 sub 등)나 접속 키 손님("key:…").
const MAX_ACTOR_ID_LENGTH = 200;

export interface EntryDownload {
  at: string;
  by: string;
  // 공개 폴더 링크로 들어온 무로그인 방문자. 이름 대신 화면에서 문구로
  // 바꿔 보여주려고 표시만 남긴다(이름 문자열을 번역하지 않기 위해).
  viaPublicLink?: boolean;
}

// 내려받기 경로. 없으면 데스크 멤버(세션 이름). public은 공개 폴더 방문자,
// share는 공유 링크(/api/share/<linkId> — 간이 링크 포함) 방문자다.
export type EntryDownloadVia = "public" | "share";

// 최근 파일 창(#16 C-1)이 읽는 변경. 업로드는 uploadedAt이 따로 맡는다.
// deleted·restored는 줄이 아니라 상태 표시다 — 마지막 표시가 deleted면 위치를
// 찾지 않고 "지워짐"으로 판정한다(휴지통으로 보낸 항목만. 지워진 폴더 안의
// 항목은 표시가 없어 위치 찾기로 가린다).
export const ENTRY_CHANGE_KINDS = [
  "edit",
  "rename",
  "move",
  "deleted",
  "restored",
] as const;
export type EntryChangeKind = (typeof ENTRY_CHANGE_KINDS)[number];

export interface EntryChange {
  at: string;
  kind: EntryChangeKind;
  // 기록 당시 세션 이름. 화면 이름(별명)은 읽을 때 byId로 다시 찾는다.
  by: string;
  // 세션 userId — 멤버는 명단 id, 접속 키 손님은 "key:…".
  byId?: string;
}

// 기록하는 쪽 — 세션의 신원(이름·id).
export type EntryActor = Pick<SessionInfo, "userId" | "name">;
// 기록 대상 — 바뀐 뒤의 항목.
export type EntryTarget = Pick<Entry, "layoutKey" | "name" | "isFolder">;

export interface EntryAudit {
  uploadedBy?: string;
  uploadedAt?: string;
  // 공개 폴더로 들어온 무로그인 방문자가 올렸다(#17 B-4). uploadedBy는 방문자가
  // 스스로 적은 이름(없을 수 있다)이라, 화면은 이 표시를 보고 "손님 · 이름"으로
  // 바꿔 보여 멤버 이름과 섞이지 않게 한다.
  uploadedByGuest?: boolean;
  downloadCount?: number;
  // 최근 것부터. 전체 횟수는 downloadCount가 따로 센다.
  downloads?: EntryDownload[];
  // 공유 링크로 받아 간 횟수와 마지막 시각(#17 B-7). 익명 링크 방문은
  // downloads(최근 20건)에 넣지 않는다 — 링크를 반복해 열어 멤버·공개 폴더
  // 내려받기 기록을 밀어내 지우지 못하게, 횟수와 마지막 시각만 센다.
  linkDownloadCount?: number;
  lastLinkDownloadAt?: string;
  // 올린 사람의 세션 userId(#16 C-1) — 최근 파일 창이 지금 화면 이름(별명)을
  // 다시 찾는 열쇠다. 속성 창은 그대로 uploadedBy를 쓴다.
  uploadedById?: string;
  // 마지막으로 기록된 이름·폴더 여부(#16 C-1). 지워진 항목도 최근 파일 창에
  // 이름으로 남기려고 둔다(지금 이름은 저장소 목록이 진실 원천이다).
  name?: string;
  isFolder?: boolean;
  // 내용 수정·이름 변경·이동 내력(#16 C-1). 최근 것부터 MAX_CHANGES건.
  changes?: EntryChange[];
}

interface EntryAuditFile {
  version: 1;
  entries: Record<string, EntryAudit>;
}

function cleanName(
  value: unknown,
  max = MAX_NAME_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

// 필드 몇 개를 뺀 얕은 복사.
function omit<T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function cleanTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}


function cleanActorId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_ACTOR_ID_LENGTH
  ) {
    return undefined;
  }
  // 제어 문자가 섞인 값은 손으로 고친 흔적이다 — 열쇠로 쓰지 않는다.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
}

function cleanChanges(value: unknown): EntryChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: EntryChange[] = [];
  for (const raw of value) {
    const record = raw as Partial<EntryChange> | null;
    const at = cleanTime(record?.at);
    const by = cleanName(record?.by);
    const kind = record?.kind;
    if (
      !at ||
      !by ||
      !(ENTRY_CHANGE_KINDS as readonly unknown[]).includes(kind)
    ) {
      continue;
    }
    const byId = cleanActorId(record?.byId);
    changes.push({
      at,
      kind: kind as EntryChangeKind,
      by,
      ...(byId ? { byId } : {}),
    });
    if (changes.length >= MAX_CHANGES) break;
  }
  return changes.length > 0 ? changes : undefined;
}

function cleanDownloads(value: unknown): EntryDownload[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const downloads: EntryDownload[] = [];
  for (const raw of value) {
    const at = cleanTime((raw as EntryDownload | null)?.at);
    const by = cleanName((raw as EntryDownload | null)?.by);
    if (!at || !by) continue;
    downloads.push(
      (raw as EntryDownload).viaPublicLink === true
        ? { at, by, viaPublicLink: true }
        : { at, by },
    );
    if (downloads.length >= MAX_DOWNLOADS) break;
  }
  return downloads.length > 0 ? downloads : undefined;
}

function cleanAudit(value: unknown): EntryAudit | null {
  const raw = value as EntryAudit | null;
  if (!raw || typeof raw !== "object") return null;
  const audit: EntryAudit = {};
  const uploadedBy = cleanName(raw.uploadedBy);
  const uploadedAt = cleanTime(raw.uploadedAt);
  const downloads = cleanDownloads(raw.downloads);
  if (uploadedBy) audit.uploadedBy = uploadedBy;
  if (uploadedAt) audit.uploadedAt = uploadedAt;
  if (raw.uploadedByGuest === true) audit.uploadedByGuest = true;
  if (downloads) audit.downloads = downloads;
  if (typeof raw.downloadCount === "number" && raw.downloadCount > 0) {
    audit.downloadCount = Math.min(
      Math.floor(raw.downloadCount),
      Number.MAX_SAFE_INTEGER,
    );
  }
  const lastLinkDownloadAt = cleanTime(raw.lastLinkDownloadAt);
  if (
    typeof raw.linkDownloadCount === "number" &&
    raw.linkDownloadCount > 0 &&
    lastLinkDownloadAt
  ) {
    audit.linkDownloadCount = Math.min(
      Math.floor(raw.linkDownloadCount),
      Number.MAX_SAFE_INTEGER,
    );
    audit.lastLinkDownloadAt = lastLinkDownloadAt;
  }
  const uploadedById = cleanActorId(raw.uploadedById);
  if (uploadedById) audit.uploadedById = uploadedById;
  const name = cleanName(raw.name, MAX_ENTRY_NAME_LENGTH);
  if (name) audit.name = name;
  if (raw.isFolder === true) audit.isFolder = true;
  const changes = cleanChanges(raw.changes);
  if (changes) audit.changes = changes;
  return Object.keys(audit).length > 0 ? audit : null;
}

// 마지막 손댄 시각 = 업로드 시각·최근 다운로드·최근 변경(#16 C-1) 중 가장 늦은
// 쪽. 상한을 넘칠 때 무엇부터 버릴지 고르는 데만 쓴다.
function lastTouchedAt(audit: EntryAudit): number {
  const times = [
    audit.uploadedAt ? Date.parse(audit.uploadedAt) : 0,
    audit.downloads?.[0]?.at ? Date.parse(audit.downloads[0].at) : 0,
    audit.changes?.[0]?.at ? Date.parse(audit.changes[0].at) : 0,
  ].filter((time) => Number.isFinite(time));
  return Math.max(0, ...times);
}

function normalize(value: unknown): EntryAuditFile {
  const raw = value as { entries?: unknown } | null;
  const entries: Record<string, EntryAudit> = {};
  if (raw?.entries && typeof raw.entries === "object") {
    for (const [key, audit] of Object.entries(
      raw.entries as Record<string, unknown>,
    )) {
      if (!key || key.length > MAX_KEY_LENGTH) continue;
      const cleaned = cleanAudit(audit);
      if (cleaned) entries[key] = cleaned;
    }
  }
  return { version: 1, entries };
}

function evictOverflow(entries: Record<string, EntryAudit>, keep: string) {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .filter((key) => key !== keep)
    .sort((left, right) => lastTouchedAt(entries[left]) - lastTouchedAt(entries[right]))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => delete entries[key]);
}

export async function getEntryAudit(
  layoutKey: string,
): Promise<EntryAudit | null> {
  if (!layoutKey) return null;
  const state = await getAdapter().readStateVersioned<EntryAuditFile>(FILE);
  return normalize(state.value).entries[layoutKey] ?? null;
}

// 최근 파일 창(#16 C-1)은 한 번에 전부 읽는다 — 상태 파일 하나(최대
// MAX_ENTRIES건)라 거르고 정렬하는 일은 읽은 쪽(recent-files)이 한다.
export async function listEntryAudits(): Promise<Record<string, EntryAudit>> {
  const state = await getAdapter().readStateVersioned<EntryAuditFile>(FILE);
  return normalize(state.value).entries;
}

// 두 기록을 합친다(앞 열쇠의 기록을 새 열쇠로 옮길 때). 하나짜리 값은 새 열쇠
// 쪽이 우선이고, 횟수는 더하며, 내력 목록은 시각순으로 섞어 상한까지 남긴다.
//
// 알려진 틈: 본문 수정 기록(열쇠 옮기기)보다 앞 열쇠로 가는 기록(예: 같은 순간의
// 내려받기)이 늦게 줄을 서면 그 한 건은 앞 열쇠에 고아로 남는다. 기록은 최선
// 노력이고 고아는 넘칠 때 오래된 것부터 버려진다.
export function mergeAudits(
  carried: EntryAudit,
  current: EntryAudit,
): EntryAudit {
  const merged: EntryAudit = { ...carried, ...current };
  const byNewest = <T extends { at: string }>(left: T, right: T) =>
    Date.parse(right.at) - Date.parse(left.at);
  const changes = [...(current.changes ?? []), ...(carried.changes ?? [])]
    .sort(byNewest)
    .slice(0, MAX_CHANGES);
  if (changes.length > 0) merged.changes = changes;
  const downloads = [
    ...(current.downloads ?? []),
    ...(carried.downloads ?? []),
  ]
    .sort(byNewest)
    .slice(0, MAX_DOWNLOADS);
  if (downloads.length > 0) merged.downloads = downloads;
  const sum = (left?: number, right?: number) =>
    Math.min((left ?? 0) + (right ?? 0), Number.MAX_SAFE_INTEGER);
  if (carried.downloadCount || current.downloadCount) {
    merged.downloadCount = sum(carried.downloadCount, current.downloadCount);
  }
  if (carried.linkDownloadCount || current.linkDownloadCount) {
    merged.linkDownloadCount = sum(
      carried.linkDownloadCount,
      current.linkDownloadCount,
    );
    const last = [carried.lastLinkDownloadAt, current.lastLinkDownloadAt]
      .filter((value): value is string => value !== undefined)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (last) merged.lastLinkDownloadAt = last;
  }
  return merged;
}

// 직행 업로드(drive)의 완료 요청이 가리키는 파일이 이 예약 뒤에 생기거나 바뀌었나
// (#16 C-1). 아니면 남이 올린 기존 파일 id를 끼워 넣은 것일 수 있다 — 그때는 올린
// 사람 기록이 없을 때만 남긴다(recordEntryUpload onlyIfUnrecorded).
export function changedSince(
  modifiedAt: string | null,
  since: string | null,
): boolean {
  if (!modifiedAt || !since) return false;
  const changed = Date.parse(modifiedAt);
  const start = Date.parse(since);
  return Number.isFinite(changed) && Number.isFinite(start) && changed >= start;
}

// 프로세스 안의 기록은 한 줄로 쓴다 — 응답 뒤 기록이 몰려도 CAS 재시도를
// 다 써서 잃지 않게(serial-queue 주석 참조).
const writeQueue = createSerialQueue();

// from: 이 항목의 앞 열쇠. local 어댑터는 본문을 바꾸면 파일 identity(layoutKey)가
// 새로 생기므로, 앞 열쇠의 기록을 새 열쇠로 옮긴 뒤 apply한다(#16 C-1).
async function mutate(
  layoutKey: string,
  apply: (audit: EntryAudit) => EntryAudit,
  from?: string,
): Promise<void> {
  if (!layoutKey || layoutKey.length > MAX_KEY_LENGTH) return;
  const previous =
    from && from !== layoutKey && from.length <= MAX_KEY_LENGTH ? from : null;
  await writeQueue(async () => {
    const adapter = getAdapter();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const state = await adapter.readStateVersioned<EntryAuditFile>(FILE);
      const file = normalize(state.value);
      let base = file.entries[layoutKey] ?? {};
      let migrated = false;
      if (previous && file.entries[previous]) {
        base = mergeAudits(file.entries[previous], base);
        delete file.entries[previous];
        migrated = true;
      }
      const next = apply(base);
      // 바꿀 것이 없다(조건부 기록) — 쓰지 않는다.
      if (next === base && !migrated) return;
      file.entries[layoutKey] = next;
      evictOverflow(file.entries, layoutKey);
      try {
        await adapter.compareAndSwapState(FILE, file, state.version);
        return;
      } catch {
        // 다른 인스턴스와 겹쳤다. 다시 읽고 시도한다.
      }
    }
  });
}

// 올린 사람(세션 이름)과 그 userId(#16 C-1)·올린 이름을 남긴다.
// onlyIfUnrecorded: 이미 올린 사람 기록이 있으면 그대로 둔다(직행 업로드 완료가
// 이 예약으로 막 생긴 파일임을 확인하지 못했을 때 — changedSince).
export async function recordEntryUpload(
  entry: EntryTarget,
  actor: EntryActor,
  options: { onlyIfUnrecorded?: boolean } = {},
): Promise<void> {
  const by = cleanName(actor.name);
  if (!by) return;
  const at = new Date().toISOString();
  const byId = cleanActorId(actor.userId);
  const name = cleanName(entry.name, MAX_ENTRY_NAME_LENGTH);
  // 같은 자리에 다시 올리면 마지막에 올린 사람이 주인이다 — 앞서 손님이
  // 올렸던 표시와 앞 주인의 id도 함께 지운다. 올린 것은 언제나 파일이다.
  await mutate(entry.layoutKey, (audit) => {
    if (
      options.onlyIfUnrecorded &&
      (audit.uploadedBy !== undefined || audit.uploadedByGuest === true)
    ) {
      return audit;
    }
    return {
      ...omit(audit, "uploadedByGuest", "uploadedById", "isFolder"),
      uploadedBy: by,
      uploadedAt: at,
      ...(byId ? { uploadedById: byId } : {}),
      ...(name ? { name } : {}),
    };
  });
}

// 공개 폴더 방문자의 업로드(#17 B-4). 이름은 방문자가 적은 값(정제는 호출자가
// nickname.parseGuestName으로 마쳤다)이고 비어 있을 수 있다 — 그래도 "손님이
// 올렸다"는 표시와 시각은 남긴다. 앞 주인의 이름이 남지 않게 uploadedBy를
// 새 값으로 바꾸거나 지운다.
export async function recordEntryGuestUpload(
  entry: EntryTarget,
  guestName: string | null,
): Promise<void> {
  const by = guestName ? cleanName(guestName) : undefined;
  const at = new Date().toISOString();
  const name = cleanName(entry.name, MAX_ENTRY_NAME_LENGTH);
  await mutate(entry.layoutKey, (audit) => ({
    ...omit(audit, "uploadedBy", "uploadedById", "isFolder"),
    ...(by ? { uploadedBy: by } : {}),
    uploadedByGuest: true,
    uploadedAt: at,
    ...(name ? { name } : {}),
  }));
}

// 내용 수정·이름 변경·이동·휴지통으로 보냄·복원(#16 C-1). 바뀐 뒤의 항목(entry)을
// 받아 지금 이름·폴더 여부를 함께 남긴다. previousLayoutKey는 바뀌기 전 열쇠 —
// local 본문 수정처럼 identity가 새로 생기면 앞 기록을 새 열쇠로 옮긴다.
export async function recordEntryChange(
  entry: EntryTarget,
  actor: EntryActor,
  kind: EntryChangeKind,
  options: { previousLayoutKey?: string } = {},
): Promise<void> {
  const by = cleanName(actor.name);
  if (!by || !(ENTRY_CHANGE_KINDS as readonly string[]).includes(kind)) return;
  const byId = cleanActorId(actor.userId);
  const change: EntryChange = {
    at: new Date().toISOString(),
    kind,
    by,
    ...(byId ? { byId } : {}),
  };
  const name = cleanName(entry.name, MAX_ENTRY_NAME_LENGTH);
  await mutate(
    entry.layoutKey,
    (audit) => ({
      ...omit(audit, "isFolder"),
      ...(name ? { name } : {}),
      ...(entry.isFolder ? { isFolder: true } : {}),
      changes: [change, ...(audit.changes ?? [])].slice(0, MAX_CHANGES),
    }),
    options.previousLayoutKey,
  );
}

// by는 받아 간 사람 이름(공개 폴더는 폴더 이름 — 화면이 문구로 바꾼다).
// via "share"는 링크 경유 횟수·마지막 시각만 올리고 by는 쓰지 않는다
// (EntryAudit.linkDownloadCount 주석 참조).
export async function recordEntryDownload(
  layoutKey: string,
  by: string,
  options: { via?: EntryDownloadVia } = {},
): Promise<void> {
  const at = new Date().toISOString();
  if (options.via === "share") {
    await mutate(layoutKey, (audit) => ({
      ...audit,
      linkDownloadCount: Math.min(
        (audit.linkDownloadCount ?? 0) + 1,
        Number.MAX_SAFE_INTEGER,
      ),
      lastLinkDownloadAt: at,
    }));
    return;
  }
  const name = cleanName(by);
  if (!name) return;
  const record: EntryDownload =
    options.via === "public"
      ? { at, by: name, viaPublicLink: true }
      : { at, by: name };
  await mutate(layoutKey, (audit) => ({
    ...audit,
    downloadCount: (audit.downloadCount ?? 0) + 1,
    downloads: [record, ...(audit.downloads ?? [])].slice(0, MAX_DOWNLOADS),
  }));
}

// 기록은 최선 노력이다 — 실패해도 본 작업(업로드·다운로드)을 막지 않는다.
// 응답 뒤(after)에 돌리고, Next 요청 문맥 밖(핸들러를 직접 부르는 테스트
// 등)에서는 after()가 던지므로 기다리지 않는 호출로 대신한다.
export function bestEffort(work: () => Promise<unknown>) {
  const run = () => work().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

// 응답 뒤에 돌므로 지금 값을 복사해 둔다(호출자가 객체를 다시 쓰더라도).
const copyTarget = (entry: EntryTarget): EntryTarget => ({
  layoutKey: entry.layoutKey,
  name: entry.name,
  isFolder: entry.isFolder,
});
const copyActor = (actor: EntryActor): EntryActor => ({
  userId: actor.userId,
  name: actor.name,
});

export function recordEntryUploadAfter(
  entry: EntryTarget,
  actor: EntryActor,
  options: { onlyIfUnrecorded?: boolean } = {},
) {
  const target = copyTarget(entry);
  const who = copyActor(actor);
  bestEffort(() => recordEntryUpload(target, who, options));
}

export function recordEntryGuestUploadAfter(
  entry: EntryTarget,
  guestName: string | null,
) {
  const target = copyTarget(entry);
  bestEffort(() => recordEntryGuestUpload(target, guestName));
}

export function recordEntryChangeAfter(
  entry: EntryTarget,
  actor: EntryActor,
  kind: EntryChangeKind,
  options: { previousLayoutKey?: string } = {},
) {
  const target = copyTarget(entry);
  const who = copyActor(actor);
  bestEffort(() => recordEntryChange(target, who, kind, options));
}

export function recordEntryDownloadAfter(
  layoutKey: string,
  by: string,
  options: { via?: EntryDownloadVia } = {},
) {
  bestEffort(() => recordEntryDownload(layoutKey, by, options));
}
