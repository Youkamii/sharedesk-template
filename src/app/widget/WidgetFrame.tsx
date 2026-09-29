import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import WidgetBand from "./WidgetBand";
import styles from "./widget.module.css";

// 로그인·가입·차단처럼 데스크 밖 화면을 위젯 창에 담는 틀.
// 머리띠는 데스크 화면과 같아서 어느 화면에서든 창을 끌고 숨길 수 있다.
export default function WidgetFrame({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <div className={styles.widget}>
      <div className={styles.wallpaper} aria-hidden="true" />
      <WidgetBand locale={locale} title="ShareDesk" />
      <main className={styles.authBody}>{children}</main>
    </div>
  );
}
