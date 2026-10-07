import type { ReactNode } from "react";
import styles from "./share-landing.module.css";

// 받기 화면(#17 B-3)의 창 틀 — 밤 배경 가운데 크림 창 하나, 청록 제목줄.
// 훅이 없어 서버(not-found)와 클라이언트(ShareLandingView) 양쪽에서 쓴다.
export default function ShareLandingFrame({
  label,
  labelledBy,
  nav,
  footer,
  children,
}: {
  label: string;
  labelledBy?: string;
  nav?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className={styles.screen}>
      <section className={styles.window} aria-labelledby={labelledBy}>
        <header className={styles.titleBar}>
          <span className={styles.brandMark} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <strong>ShareDesk</strong>
          <span className={styles.titleLabel}>{label}</span>
        </header>
        {nav}
        <div className={styles.body}>{children}</div>
        {footer !== undefined && <footer className={styles.foot}>{footer}</footer>}
      </section>
    </main>
  );
}
