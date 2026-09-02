"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { encodeQr, qrSvgPath } from "@/lib/client/qr-code";

// QR 토글(#15 A-5). 누르면 화면 가운데 오버레이로 크게 그린다 — 인코딩은
// 전부 브라우저 안에서 끝나고 외부 요청이 없다. 데스크톱 화면의 QR을 폰
// 카메라로 찍는 PC→폰 브리지가 목적이라, 행 안에 끼워 넣은 작은 그림
// 대신(스캔이 안 될 만큼 작았다) 포털로 띄운다 — 창/표의 overflow나
// z-index에 가려지지 않는다.
type Props = {
  value: string;
  // 이미 번역된 라벨.
  label: string;
  // 오버레이 닫기 버튼 라벨(호출자가 t("닫기")를 넘긴다).
  closeLabel?: string;
  className?: string;
  style?: CSSProperties;
};

const QUIET_ZONE = 4;
// 오버레이 목표 폭(px). 모듈이 정수 px가 되도록 나눠 떨어지게 맞춘다 —
// crispEdges가 소수 배율에서 칸을 고르지 않게 그리는 것을 막는다.
const TARGET_PX = 320;

export default function QrCodeToggle({
  value,
  label,
  closeLabel = "닫기",
  className,
  style,
}: Props) {
  const [open, setOpen] = useState(false);
  const qr = useMemo(() => {
    if (!open) return null;
    try {
      return encodeQr(value);
    } catch {
      // 213바이트를 넘는 값 — 이 제품의 링크·코드에서는 나올 수 없지만,
      // 만약을 위해 버튼만 남기고 조용히 그리지 않는다.
      return null;
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const sizeWithZone = qr ? qr.size + QUIET_ZONE * 2 : 0;
  const modulePx = qr ? Math.max(4, Math.round(TARGET_PX / sizeWithZone)) : 0;
  const renderedPx = sizeWithZone * modulePx;

  return (
    <>
      <button
        type="button"
        className={className}
        style={style}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open &&
        qr &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={value}
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9000,
              display: "grid",
              placeItems: "center",
              padding: 16,
              background: "rgb(8 13 28 / 62%)",
            }}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                display: "grid",
                justifyItems: "center",
                gap: 10,
                maxWidth: "min(92vw, 420px)",
                padding: 14,
                background: "#fff8e7",
                border: "3px solid #10172b",
                boxShadow: "6px 6px 0 rgb(5 9 20 / 68%)",
              }}
            >
              <svg
                role="img"
                aria-label={value}
                shapeRendering="crispEdges"
                viewBox={`0 0 ${sizeWithZone} ${sizeWithZone}`}
                width={renderedPx}
                height={renderedPx}
                style={{
                  display: "block",
                  background: "#ffffff",
                  border: "2px solid #10172b",
                  maxWidth: "min(80vw, 70vh)",
                  height: "auto",
                }}
              >
                <path d={qrSvgPath(qr.modules, 1, QUIET_ZONE)} fill="#10172b" />
              </svg>
              <span
                style={{
                  maxWidth: "100%",
                  overflowWrap: "anywhere",
                  color: "#555b69",
                  fontFamily: "monospace",
                  fontSize: 11,
                  lineHeight: 1.5,
                  textAlign: "center",
                }}
              >
                {value}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  minHeight: 34,
                  padding: "7px 18px",
                  color: "#111629",
                  background: "#ffd27d",
                  border: "2px solid #1b1b2f",
                  borderRadius: 0,
                  font: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {closeLabel}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
