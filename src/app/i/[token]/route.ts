import { NextRequest, NextResponse } from "next/server";
import {
  INVITE_COOKIE,
  INVITE_COOKIE_MAX_AGE,
  openInvitationToken,
} from "@/lib/invite-token";
import { findInvitation } from "@/lib/users";

function fail(req: NextRequest, reason: string) {
  const url = new URL("/", req.url);
  url.searchParams.set("error", reason);
  const response = NextResponse.redirect(url);
  response.cookies.set(INVITE_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const ref = openInvitationToken(token);
  if (!ref) return fail(req, "invite_invalid");
  const checked = await findInvitation(ref, { fresh: true });
  if (!checked.ok) return fail(req, checked.reason);

  const response = NextResponse.redirect(new URL("/api/auth/google", req.url));
  response.cookies.set(INVITE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: INVITE_COOKIE_MAX_AGE,
  });
  return response;
}
