import { cookies } from "next/headers";
import { LOCALE_COOKIE, resolveEffectiveLocale, translate } from "@/lib/i18n";
import { getDeskSettingsOrDefault } from "@/lib/users";
import ShareLandingFrame from "./ShareLandingFrame";
import styles from "./share-landing.module.css";

// 없거나 만료된 링크(#17 B-3) — 받기 화면과 같은 틀에 닫힘 안내만. 링크가
// 있었는지 없었는지는 구분하지 않는다(라우트의 404와 같은 존재 비노출).
export default async function ShareLinkNotFound() {
  const cookieStore = await cookies();
  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  const t = (text: string) => translate(locale, text);
  return (
    <ShareLandingFrame label={t("공유 링크")} labelledBy="share-closed-title">
      <h1 id="share-closed-title" className={styles.name}>
        {t("이 링크는 닫혔습니다")}
      </h1>
      <p className={styles.note}>{t("링크가 만료되었거나 존재하지 않습니다")}</p>
    </ShareLandingFrame>
  );
}
