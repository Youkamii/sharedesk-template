import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import FilesView from "./FilesView";

export default async function FilesPage() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const session = await resolveSession(token, { fresh: true });
  if (!session) {
    const identity = await resolveIdentity(token);
    redirect(
      identity?.status === "pending"
        ? "/join"
        : identity?.status === "blocked"
          ? "/pending"
          : "/",
    );
  }
  return (
    <FilesView
      userName={session.name}
      isAdmin={session.isAdmin}
      isGuest={session.isGuest}
    />
  );
}
