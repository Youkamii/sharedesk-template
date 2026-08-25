import { NextRequest, NextResponse } from "next/server";
import { errorResponse, runWithSession } from "@/lib/api";
import {
  listChatMessages,
  sendChatMessage,
  type ChatMessage,
} from "@/lib/chat";
import { cleanupExpiredShareLinks } from "@/lib/share-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let cleanupAfter = 0;

function clientMessage(message: ChatMessage, userId: string) {
  return {
    id: message.id,
    name: message.name,
    text: message.text,
    createdAt: message.createdAt,
    mine: message.userId === userId,
  };
}

async function cleanupIfDue() {
  const now = Date.now();
  if (now < cleanupAfter) return;
  cleanupAfter = now + CLEANUP_INTERVAL_MS;
  await cleanupExpiredShareLinks(10).catch((error) => {
    console.error("[chat] 만료 파일 정리 실패", error);
  });
}

export async function GET(req: NextRequest) {
  return runWithSession(null, async ({ session }) => {
    if (session.isGuest) {
      return NextResponse.json(
        { error: "승인된 데스크 참여자만 채팅을 사용할 수 있습니다" },
        { status: 403 },
      );
    }
    const after = req.nextUrl.searchParams.get("after") ?? undefined;
    try {
      await cleanupIfDue();
      const messages = await listChatMessages(after);
      return NextResponse.json(
        {
          messages: messages.map((message) =>
            clientMessage(message, session.userId),
          ),
          cursor: messages.at(-1)?.id ?? after ?? "",
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export async function POST(req: NextRequest) {
  return runWithSession({ fresh: true }, async ({ session }) => {
    if (session.isGuest) {
      return NextResponse.json(
        { error: "승인된 데스크 참여자만 채팅을 사용할 수 있습니다" },
        { status: 403 },
      );
    }
    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 16_384) {
      return NextResponse.json(
        { error: "메시지가 너무 깁니다" },
        { status: 413 },
      );
    }
    const body = (await req.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    try {
      const message = await sendChatMessage({
        userId: session.userId,
        name: session.name,
        text: body?.text,
      });
      return NextResponse.json(
        { message: clientMessage(message, session.userId) },
        { status: 201, headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
