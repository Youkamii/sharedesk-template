import { errorResponse, requireEditRights, requireSession } from "@/lib/api";
import {
  getFolderNote,
  MAX_FOLDER_NOTE_BYTES,
  updateFolderNote,
} from "@/lib/folder-note";
import { ROOT_ID, StorageError } from "@/lib/storage/types";

const JSON_OVERHEAD_BYTES = 4 * 1024;
const MAX_REQUEST_BYTES = MAX_FOLDER_NOTE_BYTES * 6 + JSON_OVERHEAD_BYTES;

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
          "폴더 메모는 100 KiB까지 저장할 수 있습니다",
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

export async function GET(req: Request) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const folderId = new URL(req.url).searchParams.get("folderId") ?? ROOT_ID;
  try {
    return Response.json(await getFolderNote(folderId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireEditRights({ fresh: true });
  if ("response" in auth) return auth.response;
  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new StorageError("BAD_ID", "잘못된 요청입니다");
    }
    const value = body as Record<string, unknown>;
    if (
      typeof value.folderId !== "string" ||
      typeof value.content !== "string" ||
      !(
        value.expectedVersion === null ||
        typeof value.expectedVersion === "string"
      )
    ) {
      throw new StorageError("BAD_ID", "잘못된 요청입니다");
    }
    return Response.json(
      await updateFolderNote(
        value.folderId,
        value.content,
        value.expectedVersion as string | null,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
