import { NextRequest, NextResponse } from "next/server";
import { recordActivityAfter } from "@/lib/activity";
import { errorResponse, requireUploadRights } from "@/lib/api";
import {
  deskTransferEntryUrls,
  parseDeskTransferLink,
} from "@/lib/desk-transfer";
import { DESK_FETCH_BASE, readManifest } from "@/lib/desk-transfer-source";
import { getAdapter } from "@/lib/storage";
import { ROOT_ID, StorageError } from "@/lib/storage/types";
import {
  exactSizeUploadStream,
  finishUploadReservation,
  reserveUpload,
} from "@/lib/storage-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  const auth = await requireUploadRights({ fresh: true });
  if ("response" in auth) return auth.response;

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
    reservationId = await reserveUpload({
      userId: auth.session.userId,
      parentId,
      name: manifest.name,
      size: manifest.size,
      transport: "proxy",
    });

    let response: Response;
    try {
      response = await fetch(fileUrl, DESK_FETCH_BASE);
    } catch {
      return upstreamFailed();
    }
    if (!response.ok || !response.body) return upstreamFailed();

    // 받은 스트림을 그대로 저장소로 흘린다. 파일 전체를 메모리에 담지 않으며,
    // 선언한 크기와 실제 바이트가 다르면 exactSizeUploadStream이 끊는다.
    const entry = await getAdapter().upload(
      parentId,
      manifest.name,
      manifest.mimeType || "application/octet-stream",
      exactSizeUploadStream(response.body, manifest.size),
    );
    const completed = await finishUploadReservation(
      reservationId,
      auth.session.userId,
      entry,
    );
    if (!completed) {
      throw new StorageError("CONFLICT", "업로드 완료 예약을 찾지 못했습니다");
    }
    recordActivityAfter(auth.session, "upload", entry.name);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e) {
    await finishUploadReservation(
      reservationId,
      auth.session.userId,
    ).catch(() => undefined);
    return errorResponse(e);
  }
}
