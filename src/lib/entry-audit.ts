import { after } from "next/server";
import { getAdapter } from "@/lib/storage";

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

export interface EntryDownload {
  at: string;
  by: string;
  // 공개 폴더 링크로 들어온 무로그인 방문자. 이름 대신 화면에서 문구로
  // 바꿔 보여주려고 표시만 남긴다(이름 문자열을 번역하지 않기 위해).
  viaPublicLink?: boolean;
}

export interface EntryAudit {
  uploadedBy?: string;
  uploadedAt?: string;
  downloadCount?: number;
  // 최근 것부터. 전체 횟수는 downloadCount가 따로 센다.
  downloads?: EntryDownload[];
}

interface EntryAuditFile {
  version: 1;
  entries: Record<string, EntryAudit>;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function cleanTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
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
  if (downloads) audit.downloads = downloads;
  if (typeof raw.downloadCount === "number" && raw.downloadCount > 0) {
    audit.downloadCount = Math.min(
      Math.floor(raw.downloadCount),
      Number.MAX_SAFE_INTEGER,
    );
  }
  return Object.keys(audit).length > 0 ? audit : null;
}

// 마지막 손댄 시각 = 업로드 시각과 최근 다운로드 중 늦은 쪽. 상한을 넘칠 때
// 무엇부터 버릴지 고르는 데만 쓴다.
function lastTouchedAt(audit: EntryAudit): number {
  const times = [
    audit.uploadedAt ? Date.parse(audit.uploadedAt) : 0,
    audit.downloads?.[0]?.at ? Date.parse(audit.downloads[0].at) : 0,
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

async function mutate(
  layoutKey: string,
  apply: (audit: EntryAudit) => EntryAudit,
): Promise<void> {
  if (!layoutKey || layoutKey.length > MAX_KEY_LENGTH) return;
  const adapter = getAdapter();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<EntryAuditFile>(FILE);
    const file = normalize(state.value);
    file.entries[layoutKey] = apply(file.entries[layoutKey] ?? {});
    evictOverflow(file.entries, layoutKey);
    try {
      await adapter.compareAndSwapState(FILE, file, state.version);
      return;
    } catch {
      // 다른 요청과 겹쳤다. 다시 읽고 시도한다.
    }
  }
}

export async function recordEntryUpload(
  layoutKey: string,
  actorName: string,
): Promise<void> {
  const by = cleanName(actorName);
  if (!by) return;
  const at = new Date().toISOString();
  // 같은 자리에 다시 올리면 마지막에 올린 사람이 주인이다.
  await mutate(layoutKey, (audit) => ({
    ...audit,
    uploadedBy: by,
    uploadedAt: at,
  }));
}

export async function recordEntryDownload(
  layoutKey: string,
  actorName: string,
  viaPublicLink = false,
): Promise<void> {
  const by = cleanName(actorName);
  if (!by) return;
  const at = new Date().toISOString();
  const record: EntryDownload = viaPublicLink
    ? { at, by, viaPublicLink: true }
    : { at, by };
  await mutate(layoutKey, (audit) => ({
    ...audit,
    downloadCount: (audit.downloadCount ?? 0) + 1,
    downloads: [record, ...(audit.downloads ?? [])].slice(0, MAX_DOWNLOADS),
  }));
}

// 기록은 최선 노력이다 — 실패해도 본 작업(업로드·다운로드)을 막지 않는다.
function bestEffort(work: () => Promise<void>) {
  const run = () => work().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

export function recordEntryUploadAfter(layoutKey: string, actorName: string) {
  bestEffort(() => recordEntryUpload(layoutKey, actorName));
}

export function recordEntryDownloadAfter(
  layoutKey: string,
  actorName: string,
  viaPublicLink = false,
) {
  bestEffort(() => recordEntryDownload(layoutKey, actorName, viaPublicLink));
}
