"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { encodeQr, qrSvgPath } from "@/lib/client/qr-code";

// QR 토글(#15 A-5). 누르면 그 자리에서 QR을 그린다 — 인코딩은 전부
// 브라우저 안에서 끝나고 외부 요청이 없다. 데스크톱 화면의 QR을 폰
// 카메라로 찍는 PC→폰 브리지가 목적이라 화면 크기와 무관하게 보인다.
type Props = {
  value: string;
  // 이미 번역된 라벨.
  label: string;
  className?: string;
  style?: CSSProperties;
};

const MODULE_PX = 3;
const QUIET_ZONE = 4;

export default function QrCodeToggle({ value, label, className, style }: Props) {
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

  const sizeWithZone = qr ? qr.size + QUIET_ZONE * 2 : 0;

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
      {open && qr && (
        <span style={{ display: "block", lineHeight: 0 }}>
          <svg
            role="img"
            aria-label={value}
            shapeRendering="crispEdges"
            viewBox={`0 0 ${sizeWithZone * MODULE_PX} ${sizeWithZone * MODULE_PX}`}
            width={sizeWithZone * MODULE_PX}
            height={sizeWithZone * MODULE_PX}
            style={{
              display: "block",
              marginTop: 6,
              background: "#ffffff",
              border: "2px solid #10172b",
              maxWidth: "100%",
            }}
          >
            <path
              d={qrSvgPath(qr.modules, MODULE_PX, QUIET_ZONE)}
              fill="#10172b"
            />
          </svg>
        </span>
      )}
    </>
  );
}
