import { errorResponse, runWithSession } from "@/lib/api";
import {
  leavePresenceGroup,
  listPresence,
  presenceTabLeaseId,
  type PresenceTransferInput,
  touchPresence,
} from "@/lib/presence";
import { StorageError } from "@/lib/storage/types";
import { cleanupExpiredShareLinks } from "@/lib/share-links";

const MAX_PRESENCE_BODY_BYTES = 512 * 1024;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let cleanupAfter = 0;

class PresenceBodyTooLargeError extends Error {}

async function cleanupIfDue() {
  const now = Date.now();
  if (now < cleanupAfter) return;
  cleanupAfter = now + CLEANUP_INTERVAL_MS;
  await cleanupExpiredShareLinks(10).catch((error) => {
    console.error("[presence] 만료 파일 정리 실패", error);
  });
}

function noStoreJson(value: unknown): Response {
  return Response.json(value, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  return runWithSession(null, async ({ session }) => {
    try {
      return noStoreJson(await listPresence(session.presenceParticipantId));
    } catch (error) {
      return errorResponse(error);
    }
  });
}

interface PresenceUpdate {
  tabId?: string;
  transfers?: PresenceTransferInput[];
}

async function readTextWithinLimit(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  const cancelReader = async () => {
    if (!reader) return;
    await reader.cancel("presence body limit exceeded").catch(() => undefined);
  };
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      await cancelReader();
      throw new StorageError("BAD_ID", "잘못된 요청입니다");
    }
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_PRESENCE_BODY_BYTES
    ) {
      await cancelReader();
      throw new PresenceBodyTooLargeError();
    }
  }
  if (!reader) return "";

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_PRESENCE_BODY_BYTES) {
        await cancelReader();
        throw new PresenceBodyTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readUpdate(
  request: Request,
): Promise<PresenceUpdate> {
  const text = await readTextWithinLimit(request);
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StorageError("BAD_ID", "잘못된 요청입니다");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("tabId" in body) ||
    !("transfers" in body)
  ) {
    throw new StorageError("BAD_ID", "잘못된 요청입니다");
  }
  const update = body as { tabId: unknown; transfers: PresenceTransferInput[] };
  if (typeof update.tabId !== "string") {
    throw new StorageError("BAD_ID", "잘못된 요청입니다");
  }
  return { tabId: update.tabId, transfers: update.transfers };
}

export async function POST(request: Request) {
  return runWithSession(null, async ({ session }) => {
    try {
      const update = await readUpdate(request);
      const leaseId =
        update.tabId === undefined
          ? session.presenceLeaseId
          : presenceTabLeaseId(session.presenceLeaseId, update.tabId);
      await cleanupIfDue();
      return noStoreJson(
        await touchPresence({
          participantId: session.presenceParticipantId,
          leaseId,
          name: session.name,
          ...(update.transfers === undefined
            ? {}
            : { transfers: update.transfers }),
        }),
      );
    } catch (error) {
      if (error instanceof PresenceBodyTooLargeError) {
        return Response.json(
          { error: "요청 본문이 너무 큽니다" },
          {
            status: 413,
            headers: { "Cache-Control": "private, no-store" },
          },
        );
      }
      return errorResponse(error);
    }
  });
}

export async function DELETE() {
  return runWithSession(null, async ({ session }) => {
    try {
      return noStoreJson(
        await leavePresenceGroup({
          participantId: session.presenceParticipantId,
          leaseId: session.presenceLeaseId,
          name: session.name,
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
