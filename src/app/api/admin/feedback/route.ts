import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import { sendOwnerFeedback } from "@/lib/owner-registry";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_SUBJECT_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 4_000;

class FeedbackBodyTooLargeError extends Error {}

async function readBodyWithinLimit(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("invalid_body");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new Error("invalid_body");
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_BODY_BYTES
    ) {
      await request.body?.cancel("feedback body limit exceeded").catch(() => undefined);
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
    Object.keys(record).sort().join("\n") !== "message\nsubject" ||
    typeof record.subject !== "string" ||
    typeof record.message !== "string"
  ) {
    throw new Error("invalid_body");
  }
  const subject = record.subject.trim();
  const message = record.message.trim();
  if (
    !subject ||
    subject.length > MAX_SUBJECT_LENGTH ||
    /[\r\n]/.test(subject) ||
    !message ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new Error("invalid_body");
  }
  return { subject, message };
}

function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  let feedback: { subject: string; message: string };
  try {
    feedback = await readFeedback(request);
  } catch (error) {
    if (error instanceof FeedbackBodyTooLargeError) {
      return json({ error: "피드백 내용이 너무 깁니다" }, 413);
    }
    return json({ error: "제목과 내용을 확인해 주세요" }, 400);
  }

  const result = await sendOwnerFeedback(
    request.nextUrl.origin,
    { email: auth.session.email, name: auth.session.name },
    feedback,
  );
  return json(
    result,
    result.ok ? 200 : result.reason === "disabled" ? 409 : 502,
  );
}
