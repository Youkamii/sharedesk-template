import { recordActivityAfter } from "@/lib/activity";
import {
  listPublicFolders,
  resolvePublicFolderTarget,
} from "@/lib/public-folders";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";
import { errorResponse, runWithEditRights } from "@/lib/api";
import {
  finishUploadReservation,
  reserveUpload,
} from "@/lib/storage-quota";

const MAX_TEXT_BYTES = 1024 * 1024;
const JSON_OVERHEAD_BYTES = 4 * 1024;
const MAX_REQUEST_BYTES = MAX_TEXT_BYTES * 6 + JSON_OVERHEAD_BYTES;

async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_REQUEST_BYTES
    ) {
      throw new StorageError("BAD_ID", "잘못된 요청입니다");
    }
  }

  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new StorageError(
          "BAD_ID",
          "텍스트 파일은 1 MiB까지 편집할 수 있습니다",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function PATCH(req: Request) {
  return runWithEditRights({ fresh: true }, async ({ session }) => {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new StorageError("BAD_ID", "잘못된 요청입니다");
      }
      const value = body as Record<string, unknown>;
      if (
        typeof value.id !== "string" ||
        !value.id ||
        value.id.length > 1024 ||
        typeof value.expectedVersion !== "string" ||
        !value.expectedVersion ||
        value.expectedVersion.length > 1024 ||
        typeof value.mimeType !== "string" ||
        !/^text\/plain(?:\s*;\s*charset=utf-8)?$/i.test(value.mimeType) ||
        typeof value.content !== "string"
      ) {
        throw new StorageError("BAD_ID", "잘못된 요청입니다");
      }
      const encoded = new TextEncoder().encode(value.content);
      if (encoded.byteLength > MAX_TEXT_BYTES) {
        throw new StorageError(
          "BAD_ID",
          "텍스트 파일은 1 MiB까지 편집할 수 있습니다",
        );
      }
      const adapter = getAdapter();
      const current = await adapter.getEntry(value.id);
      if (current.isFolder || !current.name.toLowerCase().endsWith(".txt")) {
        throw new StorageError("BAD_ID", ".txt 파일만 편집할 수 있습니다");
      }
      const growth = Math.max(0, encoded.byteLength - (current.size ?? 0));
      let reservationId: string | null = null;
      try {
        if (growth > 0) {
          // 공개 폴더(#10) 안 .txt면 증가분이 폴더 총 용량을 넘지 않는지
          // 판정한다 — reserveUpload는 parentId가 파일 id라 폴더 상한을
          // 모른다. editor 전용 경로라 CAS 없는 사전 실측으로 충분히
          // 좁힌다(동시 편집 경쟁 창은 수용). 스페이스 문맥은 등록부가
          // 비어 자연히 건너뛴다.
          for (const folder of await listPublicFolders()) {
            if (folder.maxTotalBytes === null) continue;
            if (!(await resolvePublicFolderTarget(folder))) continue;
            if (!(await adapter.isDirectChild(value.id, folder.folderId))) {
              continue;
            }
            const children = await adapter.list(folder.folderId);
            const usedBytes = children.reduce(
              (total, child) => total + (child.size ?? 0),
              0,
            );
            if (usedBytes + growth > folder.maxTotalBytes) {
              throw new StorageError(
                "CONFLICT",
                "공개 폴더의 저장 용량 한도를 넘었습니다",
              );
            }
            break;
          }
          reservationId = await reserveUpload({
            userId: session.userId,
            parentId: value.id,
            name: current.name,
            size: growth,
            transport: "proxy",
            enforceMaxUpload: false,
          });
        }
        const entry = await adapter.replaceContent(
          value.id,
          value.expectedVersion,
          "text/plain",
          new Response(encoded).body as ReadableStream<Uint8Array>,
        );
        await finishUploadReservation(reservationId, session.userId);
        recordActivityAfter(session, "edit", entry.name);
        return Response.json({ entry });
      } catch (error) {
        await finishUploadReservation(
          reservationId,
          session.userId,
        ).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return errorResponse(error);
    }
  });
}
