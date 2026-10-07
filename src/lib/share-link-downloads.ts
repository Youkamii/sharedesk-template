import { after } from "next/server";
import { recordEntryLinkDownload } from "@/lib/entry-audit";
import { getAdapter } from "@/lib/storage";

// 공유 링크 "받아 갔는지"(#17 B-7) — 링크마다 받아 간 횟수와 마지막 시각.
// 생성된 링크 창이 링크별로 보여 준다. share-links.json에 넣지 않고 따로
// 두는 이유: 다운로드마다 쓰는 기록이 링크 만들기·멈추기와 같은 파일을
// 두고 CAS 경합을 벌이면, 많이 받아 가는 링크 하나가 링크 관리를 실패시킬
// 수 있다. 기록은 최선 노력이다 — 실패해도 내려받기는 그대로 성공한다.
// 관례: readStateVersioned → normalize → compareAndSwapState.

const FILE = "share-link-downloads.json";
const MAX_ATTEMPTS = 4;
// 활성 링크 상한(share-links MAX_LINKS=200)의 두 배. 멈추거나 만료된 링크의
// 기록이 남아도 이 수를 넘으면 마지막으로 받아 간 시각이 오래된 것부터 버린다.
export const MAX_TRACKED_LINKS = 400;
const LINK_ID_PATTERN = /^[a-f0-9]{48}$/;

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

/** 한 번 받아 간 것을 더한 새 장부(순수). 상한을 넘으면 오래된 것부터 버린다. */
export function applyShareLinkDownload(
  file: ShareLinkDownloadFile,
  linkId: string,
  at: string,
): ShareLinkDownloadFile {
  if (!LINK_ID_PATTERN.test(linkId)) return file;
  const links = { ...file.links };
  const before = links[linkId];
  links[linkId] = {
    count: Math.min((before?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER),
    lastAt: at,
  };
  const keys = Object.keys(links);
  if (keys.length > MAX_TRACKED_LINKS) {
    keys
      .filter((key) => key !== linkId)
      .sort(
        (left, right) =>
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
    const stat = Object.prototype.hasOwnProperty.call(stats, link.linkId)
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

export async function recordShareLinkDownload(linkId: string): Promise<void> {
  if (!LINK_ID_PATTERN.test(linkId)) return;
  const adapter = getAdapter();
  const at = new Date().toISOString();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ShareLinkDownloadFile>(FILE);
    const next = applyShareLinkDownload(
      normalizeShareLinkDownloads(state.value),
      linkId,
      at,
    );
    try {
      await adapter.compareAndSwapState(FILE, next, state.version);
      return;
    } catch {
      // 다른 내려받기 기록과 겹쳤다. 다시 읽고 시도한다.
    }
  }
}

/**
 * 공유 링크로 파일 하나를 받아 간 것을 응답 뒤에 기록한다 — 링크별 횟수와
 * 그 파일의 항목별 내력(entry-audit) 둘 다. 파일 링크는 응답을 늦추지
 * 않으려고 layoutKey를 여기(응답 뒤)에서 찾는다. 어느 쪽이 실패해도 다른
 * 쪽과 내려받기 자체는 영향을 받지 않는다.
 */
export function recordShareLinkDownloadAfter(input: {
  linkId: string;
  linkName: string;
  fileId: string;
  layoutKey?: string;
}): void {
  const run = async () => {
    await Promise.allSettled([
      recordShareLinkDownload(input.linkId),
      (async () => {
        const layoutKey =
          input.layoutKey ?? (await getAdapter().getEntry(input.fileId)).layoutKey;
        await recordEntryLinkDownload(layoutKey, input.linkName);
      })(),
    ]);
  };
  const safe = () => run().catch(() => undefined);
  try {
    after(safe);
  } catch {
    // Next 요청 문맥 밖(핸들러를 직접 부르는 테스트 등)에서는 after()가
    // 던진다 — 기다리지 않는 호출로 대신한다(activity·entry-audit 관례).
    void safe();
  }
}
