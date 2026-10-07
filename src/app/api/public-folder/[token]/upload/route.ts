import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { errorResponse } from "@/lib/api";
import { recordEntryGuestUploadAfter } from "@/lib/entry-audit";
import { GUEST_NAME_HEADER, parseGuestNameHeader } from "@/lib/nickname";
import { createWindowLimiter } from "@/lib/rate-window";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";
import {
  exactSizeUploadStream,
  finishUploadReservation,
  parseUploadContentLength,
  PUBLIC_UPLOADER_PREFIX,
  reserveUpload,
} from "@/lib/storage-quota";
import { missing, resolveOpenPublicFolder } from "../shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 무세션 공개 쓰기 입구의 관례(auth·invitations 패턴): 프로세스 메모리
// rate limit — IP당 + 전역 창. IP는 위조 가능하므로 총량 상한을 병행한다.
// 본질 방어는 reserveUpload의 폴더별 상한·폴더당 공개 예약 상한이다.
const tooManyAttempts = createWindowLimiter({
  windowMs: 60_000,
  perKey: 10,
  total: 60,
});

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

// 공개 폴더(#10) 업로드 — 무로그인 외부인이 올린다. 폴더별 상한(총 용량·
// 파일 크기·개수)은 reserveUpload가 집행한다. 접근 판정까지는 404로
// 접지만, 상한 초과·이름 충돌은 방문자가 이유를 알아야 하므로 400/409
// 문구를 그대로 준다. direct(드라이브 직행) 업로드는 제공하지 않는다 —
// 상한 집행 지점을 프록시 스트림 한 곳으로 고정한다.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return runWithSpace(null, async () => {
    if (tooManyAttempts(clientIp(req))) {
      return NextResponse.json(
        { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요" },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }
    const resolved = await resolveOpenPublicFolder(token);
    if (!resolved) return missing();
    if (!req.body) {
      return NextResponse.json({ error: "본문이 없습니다" }, { status: 400 });
    }
    const name = req.nextUrl.searchParams.get("name") ?? "";
    // 보내는 사람 이름(#17 B-4) — 선택. URL 쿼리가 아니라 헤더(percent-encoding)로
    // 받는다 — 쿼리는 접근 로그에 그대로 남는다. 보이지 않는 문자를 걷어 낸 뒤
    // MAX_GUEST_NAME_LENGTH(40)자를 넘거나 풀 수 없으면 받지 않는다(화면은
    // maxLength로 막으므로 손으로 만든 요청뿐이다). 문구는 번역 키라 숫자를 그대로 적는다.
    const sender = parseGuestNameHeader(req.headers.get(GUEST_NAME_HEADER));
    if (sender === undefined) {
      return NextResponse.json(
        { error: "보내는 사람 이름은 40자까지 쓸 수 있습니다" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const mimeType =
      req.headers.get("content-type") || "application/octet-stream";
    const uploaderId = PUBLIC_UPLOADER_PREFIX + resolved.folder.id;
    let reservationId: string | null = null;
    try {
      const size = parseUploadContentLength(req.headers.get("content-length"));
      reservationId = await reserveUpload({
        userId: uploaderId,
        parentId: resolved.folder.folderId,
        name,
        size,
        // 데스크의 1회 업로드 상한은 멤버 계약이다 — 공개 폴더는 자기
        // maxFileBytes로 다스리므로 여기서는 끄고, 폴더 상한을 받는다.
        enforceMaxUpload: false,
        transport: "proxy",
      });
      const entry = await getAdapter().upload(
        resolved.folder.folderId,
        name,
        mimeType,
        exactSizeUploadStream(
          req.body as ReadableStream<Uint8Array>,
          size,
        ),
      );
      const completed = await finishUploadReservation(
        reservationId,
        uploaderId,
        entry,
      );
      if (!completed) {
        throw new StorageError("CONFLICT", "업로드 완료 예약을 찾지 못했습니다");
      }
      // 누가 올렸는지(#17 B-4) — 무로그인 표시와 함께 항목 내력·활동에 남긴다.
      // 최선 노력이라 실패해도 업로드는 성공이다.
      recordEntryGuestUploadAfter(entry, sender);
      // 활동 기록은 같은 공개 폴더에 이어 올라온 손님 업로드를 한 줄로 합친다
      // (activity.appendActivity) — 파일별 기록은 위 entry-audit에 그대로 남는다.
      recordActivityAfter(
        { name: sender ?? "", guest: true },
        "upload",
        entry.name,
        { group: `public:${resolved.folder.id}` },
      );
      return NextResponse.json(
        { entry: { id: entry.id, name: entry.name, size: entry.size } },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      await finishUploadReservation(reservationId, uploaderId).catch(
        () => undefined,
      );
      return errorResponse(e);
    }
  });
}
