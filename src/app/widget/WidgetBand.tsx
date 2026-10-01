"use client";

import { useEffect, type ReactNode } from "react";
import { installStrayDropGuard } from "@/lib/client/widget";
import styles from "./widget.module.css";

// 위젯 창 맨 위 머리띠 — 껍데기 창을 끄는 드래그 영역이자 공용 조작 자리.
// data-tauri-drag-region="deep"은 껍데기가 주입한 스크립트가 읽는다 (브라우저에서는 무해):
// 머리띠 안 어디를 눌러도(단추 제외) 창이 끌린다. 값 없는 표식은 "그 요소를 직접 눌렀을 때"만이라
// 접속 점 같은 자식 위에서는 끌리지 않는다(실측).
// 숨기기 단추는 없다(#30) — 위젯 숨기기는 트레이 아이콘·트레이 메뉴가 맡는다.
export default function WidgetBand({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  // 화면 어디에 파일을 놓아도 웹뷰가 그 파일로 이동하지 않게 한다 (서랍 모드의 업로드 영역은 먼저 처리한다)
  useEffect(() => installStrayDropGuard(document), []);
  return (
    <header className={styles.band} data-tauri-drag-region="deep">
      <span className={styles.brandMark} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <strong className={styles.bandTitle}>{title}</strong>
      {children}
    </header>
  );
}
