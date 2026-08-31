"use client";

import type { CSSProperties } from "react";
import {
  shareLinkNative,
  shareTextNative,
  useNativeShare,
  type ShareOutcome,
} from "@/lib/client/share-link-out";

// OS 공유 시트 버튼(#15 A-4). navigator.share가 있는 환경(폰)에서만
// 나타난다 — 데스크톱의 "복사" 습관은 건드리지 않는다. url이 있으면 링크
// 공유, 없으면 text(초대 코드 등) 공유.
type Props = {
  url?: string;
  text?: string;
  title?: string;
  // 이미 번역된 라벨을 받는다 — 이 컴포넌트는 locale을 모른다.
  label: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  // 시트가 없어 복사로 내려갔을 때(copied)와 그마저 막혔을 때(manual)만
  // 호출한 쪽이 알림을 띄우면 된다. shared·dismissed는 조용히 끝난다.
  onOutcome?: (outcome: ShareOutcome) => void;
};

export default function ShareOutButton({
  url,
  text,
  title,
  label,
  className,
  style,
  disabled,
  onOutcome,
}: Props) {
  const canShare = useNativeShare();
  if (!canShare) return null;

  async function run() {
    const outcome =
      url !== undefined
        ? await shareLinkNative(url, title)
        : await shareTextNative(text ?? "");
    onOutcome?.(outcome);
  }

  return (
    <button
      type="button"
      className={className}
      style={style}
      disabled={disabled}
      onClick={() => void run()}
    >
      {label}
    </button>
  );
}
