"use client";

import { useSyncExternalStore } from "react";

// 링크를 밖으로 내보내는 문(#15 A-4). 폰에서는 OS 공유 시트로 카톡·메시지에
// 바로 보내고, 시트가 없거나 거부되면 클립보드 복사로 내려간다. 기존 "복사"
// 버튼은 그대로 두고, share를 지원하는 환경에서만 "공유" 버튼이 하나 더
// 붙는다 — 데스크톱의 복사 습관을 바꾸지 않기 위해서다.

export type ShareOutcome =
  // OS 공유 시트가 열려 사용자가 대상 앱까지 골랐다.
  | "shared"
  // 시트를 열었지만 사용자가 그냥 닫았다 — 실패도 성공 알림도 아니다.
  | "dismissed"
  // 시트가 없거나 거부돼 클립보드 복사로 내려갔다.
  | "copied"
  // 클립보드까지 막혔다 — 호출한 쪽이 주소를 직접 보여줘야 한다.
  | "manual";

type ShareCapableNavigator = Navigator & {
  share?: (data: { url?: string; title?: string; text?: string }) => Promise<void>;
};

function nativeShareAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as ShareCapableNavigator).share === "function"
  );
}

// share 지원 여부는 마운트 뒤에만 알 수 있다(SSR엔 navigator가 없다).
// 서버 스냅숏은 false — 첫 페인트에는 공유 버튼이 없다가 폰에서 나타난다.
function subscribeNoop() {
  return () => {};
}

export function useNativeShare(): boolean {
  return useSyncExternalStore(subscribeNoop, nativeShareAvailable, () => false);
}

export async function shareLinkNative(
  url: string,
  title?: string,
): Promise<ShareOutcome> {
  const nav = navigator as ShareCapableNavigator;
  if (typeof nav.share === "function") {
    try {
      await nav.share(title ? { url, title } : { url });
      return "shared";
    } catch (error) {
      // 사용자가 시트를 닫은 것은 실패가 아니다 — 조용히 끝낸다.
      if ((error as DOMException | null)?.name === "AbortError") {
        return "dismissed";
      }
      // 그 외(NotAllowedError 등)는 복사로 내려간다.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "manual";
  }
}

// 초대 코드처럼 주소가 아닌 글자를 보낼 때 쓴다.
export async function shareTextNative(text: string): Promise<ShareOutcome> {
  const nav = navigator as ShareCapableNavigator;
  if (typeof nav.share === "function") {
    try {
      await nav.share({ text });
      return "shared";
    } catch (error) {
      if ((error as DOMException | null)?.name === "AbortError") {
        return "dismissed";
      }
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "manual";
  }
}
