"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALES,
  translate,
  type Locale,
} from "@/lib/i18n";

// 참여자 개별 언어 메뉴: 다섯 언어 중 하나를 골라 쿠키에 저장하고
// 서버 컴포넌트를 새로 그려 모든 화면에 적용한다. 스타일은 호출한
// 화면의 CSS 모듈 클래스를 그대로 받아 그 화면의 메뉴 모양을 재사용한다.
export default function LanguageMenu({
  locale,
  className,
  wrapperClassName,
  menuClassName,
  itemClassName,
}: {
  locale: Locale;
  className?: string;
  wrapperClassName?: string;
  menuClassName?: string;
  itemClassName?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const label = translate(locale, "언어 선택");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!areaRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // 캡처 단계로 들어야 stopPropagation을 쓰는 요소를 클릭해도 닫힌다.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectLocale = (next: Locale) => {
    setOpen(false);
    // 같은 언어를 골라도 쿠키를 남긴다 — 데스크 언어가 나중에 바뀌어도
    // 본인이 명시한 선택(resolveEffectiveLocale의 개인 쿠키)이 유지된다.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };

  return (
    <div
      ref={areaRef}
      className={wrapperClassName}
      style={wrapperClassName ? undefined : { position: "relative" }}
    >
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        {LOCALE_LABELS[locale]}
      </button>
      {open && (
        <div role="menu" aria-label={label} className={menuClassName}>
          {LOCALES.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === locale}
              className={itemClassName}
              onClick={() => selectLocale(item)}
            >
              {LOCALE_LABELS[item]}
              {item === locale && <kbd>✓</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
