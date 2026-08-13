import { errorResponse, requireSession } from "@/lib/api";
import {
  leavePresence,
  listPresence,
  touchPresence,
} from "@/lib/presence";

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

export async function POST() {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  try {
    return noStoreJson(
      await touchPresence({
        participantId: auth.session.presenceParticipantId,
        leaseId: auth.session.presenceLeaseId,
        name: auth.session.name,
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
      await leavePresence({
        participantId: auth.session.presenceParticipantId,
        leaseId: auth.session.presenceLeaseId,
        name: auth.session.name,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
