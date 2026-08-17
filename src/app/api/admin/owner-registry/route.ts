import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api";
import {
  getOwnerRegistryStatus,
  recordOwnerRegistryObservation,
} from "@/lib/owner-registry";

export const runtime = "nodejs";

const MAX_CONFIRM_BODY_BYTES = 64;

class ConfirmationBodyTooLargeError extends Error {}
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

async function readConfirmation(request: Request): Promise<void> {
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
      declaredBytes > MAX_CONFIRM_BODY_BYTES
    ) {
      await request.body
        ?.cancel("owner registry confirmation body limit exceeded")
        .catch(() => undefined);
      throw new ConfirmationBodyTooLargeError();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_CONFIRM_BODY_BYTES) {
        await reader
          .cancel("owner registry confirmation body limit exceeded")
          .catch(() => undefined);
        throw new ConfirmationBodyTooLargeError();
      }
      chunks.push(chunk.value);
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

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_body");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).join("\n") !== "confirm" ||
    (body as { confirm?: unknown }).confirm !== true
  ) {
    throw new Error("invalid_body");
  }
}

function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  return NextResponse.json(getOwnerRegistryStatus(req.nextUrl.origin), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin({ fresh: true });
  if ("response" in auth) return auth.response;

  if (!isSameOrigin(req)) {
    return json({ error: "같은 사이트에서만 요청할 수 있습니다" }, 403);
  }
  try {
    await readConfirmation(req);
  } catch (error) {
    if (error instanceof ConfirmationBodyTooLargeError) {
      return json({ error: "확인 요청이 너무 큽니다" }, 413);
    }
    if (error instanceof InvalidContentTypeError) {
      return json({ error: "JSON 요청만 사용할 수 있습니다" }, 415);
    }
    return json({ error: "설치 등록 확인 값을 확인해 주세요" }, 400);
  }

  const result = await recordOwnerRegistryObservation(
    req.nextUrl.origin,
    auth.session.email,
  );
  return json(result, result.ok ? 200 : result.reason === "disabled" ? 409 : 502);
}
