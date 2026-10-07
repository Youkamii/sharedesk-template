import { bestEffort, recordEntryDownload } from "@/lib/entry-audit";
import { createWindowLimiter } from "@/lib/rate-window";
import { createSerialQueue } from "@/lib/serial-queue";
import { getAdapter } from "@/lib/storage";

// 공유 링크 "받아 갔는지"(#17 B-7) — 링크마다 받아 간 횟수와 마지막 시각.
// 생성된 링크 창이 링크별로 보여 준다. share-links.json에 넣지 않고 따로
// 두는 이유: 다운로드마다 쓰는 기록이 링크 만들기·멈추기와 같은 파일을
// 두고 CAS 경합을 벌이면, 많이 받아 가는 링크 하나가 링크 관리를 실패시킬
// 수 있다. 기록은 최선 노력이다 — 실패해도 내려받기는 그대로 성공한다.
// 관례: readStateVersioned → normalize → compareAndSwapState.

const FILE = "share-link-downloads.json";
const MAX_ATTEMPTS = 4;
// 활성 링크 상한(share-links MAX_LINKS=200)의 두 배. 링크를 멈추거나 만료
// 정리할 때 함께 지우지만(share-links), 그래도 넘치면 죽은 링크부터 버린다.
export const MAX_TRACKED_LINKS = 400;
const LINK_ID_PATTERN = /^[a-f0-9]{48}$/;

// 익명 GET마다 상태 파일 두 개(이 장부·entry-audit)를 쓰므로, 기록에만 상한을
// 둔다 — 링크당 분당 6회·전역 분당 60회. 넘은 내려받기는 정상으로 응답하되
// 세지 않고 버린다(내려받기 자체는 막지 않는다).
export const RECORD_LIMIT_PER_LINK = 6;
export const RECORD_LIMIT_TOTAL = 60;
const recordLimiter = createWindowLimiter({
  windowMs: 60_000,
  perKey: RECORD_LIMIT_PER_LINK,
  total: RECORD_LIMIT_TOTAL,
});
// 프로세스 안의 장부 쓰기는 한 줄로 — 같은 링크를 연달아 받아도 CAS 재시도를
// 다 써서 기록을 잃지 않게(serial-queue 주석 참조).
const writeQueue = createSerialQueue();

export interface ShareLinkDownloadStat {
  count: number;
  lastAt: string;
}

export interface ShareLinkDownloadFile {
  version: 1;
  links: Record<string, ShareLinkDownloadStat>;
}

// 링크 목록 응답에 덧붙는 값. 한 번도 안 받았으면 0·null.
export interface ShareLinkDownloadSummary {
  downloadCount: number;
  lastDownloadAt: string | null;
}

export function normalizeShareLinkDownloads(
  value: unknown,
): ShareLinkDownloadFile {
  const raw = value as { links?: unknown } | null;
  const links: Record<string, ShareLinkDownloadStat> = {};
  if (raw?.links && typeof raw.links === "object" && !Array.isArray(raw.links)) {
    for (const [linkId, stat] of Object.entries(
      raw.links as Record<string, unknown>,
    )) {
      if (!LINK_ID_PATTERN.test(linkId)) continue;
      const candidate = stat as Partial<ShareLinkDownloadStat> | null;
      if (!candidate || typeof candidate !== "object") continue;
      if (
        typeof candidate.count !== "number" ||
        !Number.isFinite(candidate.count) ||
        candidate.count < 1
      ) {
        continue;
      }
      if (typeof candidate.lastAt !== "string") continue;
      const lastAt = Date.parse(candidate.lastAt);
      if (!Number.isFinite(lastAt)) continue;
      links[linkId] = {
        count: Math.min(Math.floor(candidate.count), Number.MAX_SAFE_INTEGER),
        lastAt: new Date(lastAt).toISOString(),
      };
    }
  }
  return { version: 1, links };
}

/**
 * 한 번 받아 간 것을 더한 새 장부(순수). 상한을 넘으면 버릴 것을 고른다 —
 * 활성 링크 목록(activeLinkIds)을 받았으면 목록에 없는(죽은) 링크부터,
 * 그다음 활성 링크 중 마지막으로 받은 시각이 오래된 것 순. 방금 받은
 * 링크는 버리지 않는다.
 */
export function applyShareLinkDownload(
  file: ShareLinkDownloadFile,
  linkId: string,
  at: string,
  activeLinkIds?: ReadonlySet<string>,
): ShareLinkDownloadFile {
  if (!LINK_ID_PATTERN.test(linkId)) return file;
  const links = { ...file.links };
  const before = Object.hasOwn(links, linkId) ? links[linkId] : undefined;
  links[linkId] = {
    count: Math.min((before?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER),
    lastAt: at,
  };
  const keys = Object.keys(links);
  if (keys.length > MAX_TRACKED_LINKS) {
    const alive = (key: string) => (activeLinkIds?.has(key) ? 1 : 0);
    keys
      .filter((key) => key !== linkId)
      .sort(
        (left, right) =>
          alive(left) - alive(right) ||
          Date.parse(links[left].lastAt) - Date.parse(links[right].lastAt),
      )
      .slice(0, keys.length - MAX_TRACKED_LINKS)
      .forEach((key) => delete links[key]);
  }
  return { version: 1, links };
}

/** 링크 목록에 받아 간 횟수·마지막 시각을 붙인다(순수). */
export function withShareLinkDownloads<T extends { linkId: string }>(
  links: T[],
  stats: Record<string, ShareLinkDownloadStat>,
): Array<T & ShareLinkDownloadSummary> {
  return links.map((link) => {
    const stat = Object.hasOwn(stats, link.linkId)
      ? stats[link.linkId]
      : undefined;
    return {
      ...link,
      downloadCount: stat?.count ?? 0,
      lastDownloadAt: stat?.lastAt ?? null,
    };
  });
}

export async function readShareLinkDownloads(): Promise<
  Record<string, ShareLinkDownloadStat>
> {
  const state = await getAdapter().readStateVersioned<ShareLinkDownloadFile>(
    FILE,
  );
  return normalizeShareLinkDownloads(state.value).links;
}

// 활성 링크 id — 장부가 넘칠 때만 읽는다. share-links가 이 모듈을 불러
// 정리하므로(forgetShareLinkDownloads), 정적 순환을 피해 필요할 때 연다.
async function activeLinkIds(): Promise<Set<string>> {
  const { listShareLinks } = await import("@/lib/share-links");
  return new Set((await listShareLinks()).map((link) => link.linkId));
}

export async function recordShareLinkDownload(linkId: string): Promise<void> {
  if (!LINK_ID_PATTERN.test(linkId)) return;
  const at = new Date().toISOString();
  await writeQueue(async () => {
    const adapter = getAdapter();
    let active: Set<string> | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const state = await adapter.readStateVersioned<ShareLinkDownloadFile>(FILE);
      const file = normalizeShareLinkDownloads(state.value);
      if (
        !active &&
        !Object.hasOwn(file.links, linkId) &&
        Object.keys(file.links).length >= MAX_TRACKED_LINKS
      ) {
        active = await activeLinkIds();
      }
      const next = applyShareLinkDownload(file, linkId, at, active);
      try {
        await adapter.compareAndSwapState(FILE, next, state.version);
        return;
      } catch {
        // 다른 인스턴스의 기록과 겹쳤다. 다시 읽고 시도한다.
      }
    }
  });
}

/** 멈추거나 만료 정리된 링크의 기록을 지운다(share-links가 부른다). */
export async function forgetShareLinkDownloads(
  linkIds: readonly string[],
): Promise<void> {
  if (linkIds.length === 0) return;
  await writeQueue(async () => {
    const adapter = getAdapter();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const state = await adapter.readStateVersioned<ShareLinkDownloadFile>(FILE);
      const file = normalizeShareLinkDownloads(state.value);
      const present = linkIds.filter((linkId) => Object.hasOwn(file.links, linkId));
      if (present.length === 0) return;
      for (const linkId of present) delete file.links[linkId];
      try {
        await adapter.compareAndSwapState(FILE, file, state.version);
        return;
      } catch {
        // 겹쳤다. 다시 읽고 시도한다.
      }
    }
  });
}

/**
 * 공유 링크로 파일 하나를 받아 간 것을 응답 뒤에 기록한다 — 링크별 횟수와
 * 그 파일의 링크 경유 횟수(entry-audit) 둘 다. 기록 상한(링크당·전역 분당)을
 * 넘으면 아무것도 쓰지 않는다. 파일 링크는 응답을 늦추지 않으려고
 * layoutKey를 응답 뒤에 찾는다. 어느 쪽이 실패해도 다른 쪽과 내려받기
 * 자체는 영향을 받지 않는다.
 */
export function recordShareLinkDownloadAfter(input: {
  linkId: string;
  linkName: string;
  fileId: string;
  layoutKey?: string;
}): void {
  if (recordLimiter(input.linkId)) return;
  bestEffort(() =>
    Promise.allSettled([
      recordShareLinkDownload(input.linkId),
      (async () => {
        const layoutKey =
          input.layoutKey ?? (await getAdapter().getEntry(input.fileId)).layoutKey;
        await recordEntryDownload(layoutKey, input.linkName, { via: "share" });
      })(),
    ]),
  );
}
