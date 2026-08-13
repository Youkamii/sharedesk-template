import { errorResponse, requireSession } from "@/lib/api";
import {
  leavePresenceGroup,
  listPresence,
  presenceTabLeaseId,
  type PresenceTransferInput,
  touchPresence,
} from "@/lib/presence";
import { StorageError } from "@/lib/storage/types";

function noStoreJson(value: unknown): Response {
  return Response.json(value, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  try {
    return noStoreJson(
      await listPresence(auth.session.presenceParticipantId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

interface PresenceUpdate {
  tabId?: string;
  transfers?: PresenceTransferInput[];
}

async function readUpdate(
  request: Request,
): Promise<PresenceUpdate> {
  const text = await request.text();
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
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  try {
    const update = await readUpdate(request);
    const leaseId =
      update.tabId === undefined
        ? auth.session.presenceLeaseId
        : presenceTabLeaseId(auth.session.presenceLeaseId, update.tabId);
    return noStoreJson(
      await touchPresence({
        participantId: auth.session.presenceParticipantId,
        leaseId,
        name: auth.session.name,
        ...(update.transfers === undefined
          ? {}
          : { transfers: update.transfers }),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE() {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  try {
    return noStoreJson(
      await leavePresenceGroup({
        participantId: auth.session.presenceParticipantId,
        leaseId: auth.session.presenceLeaseId,
        name: auth.session.name,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
