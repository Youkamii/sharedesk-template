import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";
import { errorResponse, requireSession } from "@/lib/api";

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
  const auth = await requireSession({ fresh: true });
  if ("response" in auth) return auth.response;

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
      throw new StorageError("BAD_ID", "텍스트 파일은 1 MiB까지 편집할 수 있습니다");
    }
    const adapter = getAdapter();
    const current = await adapter.getEntry(value.id);
    if (current.isFolder || !current.name.toLowerCase().endsWith(".txt")) {
      throw new StorageError("BAD_ID", ".txt 파일만 편집할 수 있습니다");
    }
    const entry = await adapter.replaceContent(
      value.id,
      value.expectedVersion,
      "text/plain",
      new Response(encoded).body as ReadableStream<Uint8Array>,
    );
    return Response.json({ entry });
  } catch (error) {
    return errorResponse(error);
  }
}
