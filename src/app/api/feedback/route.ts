import { NextRequest, NextResponse } from "next/server";
import { runWithSession } from "@/lib/api";
import { sendOwnerFeedback } from "@/lib/owner-registry";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_SUBJECT_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 4_000;
const FEEDBACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FeedbackBodyTooLargeError extends Error {}
class InvalidContentTypeError extends Error {}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      .trim()
      .toLowerCase();
    const protocol =
      forwardedProtocol === "http" || forwardedProtocol === "https"
        ? forwardedProtocol
        : request.nextUrl.protocol.slice(0, -1);
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

async function readBodyWithinLimit(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.split(";", 1)[0].trim() !== "application/json") {
    throw new InvalidContentTypeError();
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new Error("invalid_body");
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_BODY_BYTES
    ) {
      await request.body
        ?.cancel("feedback body limit exceeded")
        .catch(() => undefined);
      throw new FeedbackBodyTooLargeError();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("feedback body limit exceeded").catch(() => undefined);
        throw new FeedbackBodyTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readFeedback(request: Request): Promise<{
  feedbackId: string;
  subject: string;
  message: string;
}> {
  const text = await readBodyWithinLimit(request);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("invalid_body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid_body");
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\n") !== "feedbackId\nmessage\nsubject" ||
    typeof record.feedbackId !== "string" ||
    typeof record.subject !== "string" ||
    typeof record.message !== "string"
  ) {
    throw new Error("invalid_body");
  }
  const subject = record.subject.trim();
  const message = record.message.trim();
  if (
    !FEEDBACK_ID_PATTERN.test(record.feedbackId) ||
    !subject ||
    subject.length > MAX_SUBJECT_LENGTH ||
    /[\r\n]/.test(subject) ||
    !message ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new Error("invalid_body");
  }
  return {
    feedbackId: record.feedbackId.toLowerCase(),
    subject,
    message,
  };
}

function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  return runWithSession({ fresh: true }, async ({ session }) => {
    if (!session.email.trim()) {
      return json(
        { error: "Google 로그인 사용자만 피드백을 보낼 수 있습니다" },
        403,
      );
    }
    if (!isSameOrigin(request)) {
      return json({ error: "같은 사이트에서만 요청할 수 있습니다" }, 403);
    }

    let feedback: { feedbackId: string; subject: string; message: string };
    try {
      feedback = await readFeedback(request);
    } catch (error) {
      if (error instanceof FeedbackBodyTooLargeError) {
        return json({ error: "피드백 내용이 너무 깁니다" }, 413);
      }
      if (error instanceof InvalidContentTypeError) {
        return json({ error: "JSON 요청만 사용할 수 있습니다" }, 415);
      }
      return json({ error: "제목과 내용을 확인해 주세요" }, 400);
    }

    const result = await sendOwnerFeedback(
      request.nextUrl.origin,
      { email: session.email, name: session.name },
      feedback,
    );
    return json(
      result,
      result.ok ? 200 : result.reason === "disabled" ? 409 : 502,
    );
  });
}
