import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { errorResponse, runWithUploadRights } from "@/lib/api";
import { recordEntryUploadAfter } from "@/lib/entry-audit";
import {
  deskTransferEntryUrls,
  parseDeskTransferLink,
} from "@/lib/desk-transfer";
import {
  DESK_FETCH_BASE,
  readManifest,
  resolvesToPublicAddress,
} from "@/lib/desk-transfer-source";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID, StorageError } from "@/lib/storage/types";
import {
  exactSizeUploadStream,
  finishUploadReservation,
  reserveUpload,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 파일 본문을 받는 시간의 상한. 느리게 흘리는 상대가 저장소의 전역 쓰기
// 잠금을 무기한 붙잡지 못하게 한다.
const FILE_TIMEOUT_MS = 4 * 60 * 1000;

// 보내는 쪽 문제를 catch까지 올려 예약이 반드시 정리되게 하는 표식.
class UpstreamFailure extends Error {}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function upstreamFailed() {
  return NextResponse.json(
    { error: "보내는 데스크에서 파일을 가져오지 못했습니다" },
    { status: 502 },
  );
}

/**
 * 다른 데스크의 공개 링크에서 파일 하나를 받아 이 데스크에 저장한다.
 * 폴더는 받는 쪽 화면이 목록을 훑어 파일별로 이 경로를 다시 부른다 — 한 번의
 * 호출에 폴더 전체를 담으면 함수 실행 시간을 넘긴다.
 */
export async function POST(req: NextRequest) {
  return runWithUploadRights({ fresh: true }, async ({ session }) => {
    const parentId = req.nextUrl.searchParams.get("parentId") ?? ROOT_ID;

    let body: { url?: unknown; entryId?: unknown };
    try {
      body = (await req.json()) as { url?: unknown; entryId?: unknown };
    } catch {
      return badRequest("요청 본문을 읽지 못했습니다");
    }

    const source = parseDeskTransferLink(body.url);
    if (!source) {
      return badRequest("다른 데스크의 공개 링크 주소가 아닙니다");
    }
    // 이름 모양을 통과해도 실제로 내부망을 가리키면 거부한다.
    if (!(await resolvesToPublicAddress(new URL(source.origin).hostname))) {
      return badRequest("다른 데스크의 공개 링크 주소가 아닙니다");
    }

    // 폴더 링크 안의 특정 파일을 지정한 경우.
    let fileUrl = source.fileUrl;
    let manifestUrl = source.manifestUrl;
    if (body.entryId !== undefined && body.entryId !== null) {
      if (typeof body.entryId !== "string") {
        return badRequest("항목 id가 올바르지 않습니다");
      }
      const urls = deskTransferEntryUrls(source, body.entryId);
      if (!urls) return badRequest("항목 id가 올바르지 않습니다");
      fileUrl = urls.fileUrl;
      manifestUrl = urls.manifestUrl;
    }

    const manifest = await readManifest(manifestUrl);
    if (!manifest) return upstreamFailed();
    if (manifest.kind !== "file") {
      return badRequest(
        "폴더는 한 번에 받을 수 없습니다. 안의 파일을 하나씩 받아 주세요",
      );
    }

    let reservationId: string | null = null;
    try {
      // 보내는 쪽이 알려 준 크기로 먼저 자리를 잡는다. 크기를 모르면 예약할 수
      // 없으므로 거부한다 — 용량 한도를 넘겨 쓰는 경로를 만들지 않는다.
      if (manifest.size === null) {
        throw new StorageError("BAD_ID", "파일 크기를 확인하지 못했습니다");
      }
      // 저장소가 이름을 trim해서 돌려주므로 예약도 같은 값으로 잡아야 한다.
      // 다르면 정산 단계의 이름 비교가 어긋나, 파일은 저장됐는데 실패로 보고된다.
      const name = manifest.name.trim();
      reservationId = await reserveUpload({
        userId: session.userId,
        parentId,
        name,
        size: manifest.size,
        transport: "proxy",
      });

      // 실패를 예외로 올린다. 여기서 그냥 return하면 catch를 타지 않아 예약이
      // 1시간(PROXY_RESERVATION_TTL_MS) 동안 남고, 반복되면 데스크 전체의
      // 업로드가 용량 부족으로 막힌다.
      let response: Response;
      try {
        response = await fetch(fileUrl, {
          ...DESK_FETCH_BASE,
          // 느리게 흘리는 상대가 저장소 잠금을 무기한 쥐지 못하게 상한을 둔다.
          signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
        });
      } catch {
        throw new UpstreamFailure();
      }
      if (!response.ok || !response.body) {
        // 소켓을 붙잡지 않도록 본문을 버린다.
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamFailure();
      }

      // 받은 스트림을 그대로 저장소로 흘린다. 파일 전체를 메모리에 담지 않으며,
      // 선언한 크기와 실제 바이트가 다르면 exactSizeUploadStream이 끊는다.
      const entry = await getAdapter().upload(
        parentId,
        name,
        manifest.mimeType || "application/octet-stream",
        exactSizeUploadStream(response.body, manifest.size),
      );
      const completed = await finishUploadReservation(
        reservationId,
        session.userId,
        entry,
      );
      reservationId = null;
      if (!completed) {
        throw new StorageError("CONFLICT", "업로드 완료 예약을 찾지 못했습니다");
      }
      recordActivityAfter(session, "upload", entry.name);
      recordEntryUploadAfter(entry.layoutKey, session.name);
      return NextResponse.json({ entry }, { status: 201 });
    } catch (e) {
      await finishUploadReservation(
        reservationId,
        session.userId,
      ).catch(() => undefined);
      if (e instanceof UpstreamFailure) return upstreamFailed();
      return errorResponse(e);
    }
  });
}
