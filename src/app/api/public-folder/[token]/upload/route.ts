import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
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
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_TOTAL = 60;
const attempts = new Map<string, { count: number; resetAt: number }>();
let totalWindow = { count: 0, resetAt: 0 };

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  if (now > totalWindow.resetAt) {
    totalWindow = { count: 0, resetAt: now + WINDOW_MS };
  }
  totalWindow.count++;
  if (totalWindow.count > MAX_ATTEMPTS_TOTAL) return true;

  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (attempts.size > 1000) {
      for (const [key, value] of attempts) {
        if (now > value.resetAt) attempts.delete(key);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS_PER_IP;
}

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
