import { AsyncLocalStorage } from "node:async_hooks";

// 현재 요청이 보는 스페이스의 AsyncLocalStorage 저장고. 어댑터(storage/local·
// drive)가 루트 해석 때 읽으므로, 여기는 다른 어떤 모듈도 import하지 않는다 —
// 등록부(spaces.ts)까지 끌고 오면 storage와 순환이 생긴다.
//
// 문맥이 없으면 기본 스페이스(설치 루트)다. 기존 단일 데스크의 모든 경로가
// 그대로 동작해야 하기 때문이다.

export interface SpaceContext {
  slug: string | null;
  // 이 스페이스의 저장소 루트. drive는 폴더 id, local은 루트 기준 상대경로.
  // null이면 설치 루트 그 자체.
  folderId: string | null;
}

const storage = new AsyncLocalStorage<SpaceContext>();

export const DEFAULT_SPACE_CONTEXT: SpaceContext = {
  slug: null,
  folderId: null,
};

/** 어댑터가 읽는 값 — 현재 요청이 보는 스페이스의 저장소 루트. */
export function currentSpaceFolderId(): string | null {
  return storage.getStore()?.folderId ?? null;
}

/** 현재 스페이스 슬러그. null이면 기본(레거시) 데스크. 주로 테스트·진단용 —
 *  판정은 resolveSpaceSession이 명시 인자로 받는다. */
export function currentSpaceSlug(): string | null {
  return storage.getStore()?.slug ?? null;
}

/**
 * 주어진 문맥 안에서 fn을 돌린다. 문맥을 세우는 방법은 이것 하나뿐이다 —
 * run()은 fn이 끝나면 바깥 문맥을 복원하므로 요청·작업 사이에 새지 않는다.
 * enterWith는 되돌림 지점이 없어 요청 경계를 보장하지 못하므로 쓰지 않는다.
 */
export function runWithSpace<T>(context: SpaceContext | null, fn: () => T): T {
  return storage.run(context ?? DEFAULT_SPACE_CONTEXT, fn);
}
