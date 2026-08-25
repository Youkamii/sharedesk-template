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

/** 화면·API가 읽는 값 — 현재 스페이스 슬러그. null이면 기본(레거시) 데스크. */
export function currentSpaceSlug(): string | null {
  return storage.getStore()?.slug ?? null;
}

/** 주어진 문맥 안에서 fn을 돌린다. 테스트·백그라운드 작업용. */
export function runWithSpace<T>(context: SpaceContext | null, fn: () => T): T {
  return storage.run(context ?? DEFAULT_SPACE_CONTEXT, fn);
}

/**
 * 현재 비동기 흐름의 남은 구간에 문맥을 얹는다. 요청마다 핸들러가 새 문맥에서
 * 시작하므로 요청 사이에 새지 않는다.
 */
export function enterSpace(context: SpaceContext): void {
  storage.enterWith(context);
}
