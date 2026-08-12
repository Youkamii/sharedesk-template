import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import FilesView from "./FilesView";

export default async function FilesPage() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const session = await resolveSession(token, { fresh: true });
  if (!session) {
    // 서명은 멀쩡한데 승인이 안 난 경우와, 아예 세션이 없는 경우를 구분해 안내한다.
    const identity = await resolveIdentity(token);
    redirect(identity ? "/pending" : "/");
  }
  return (
    <FilesView
      userName={session.name}
      isAdmin={session.isAdmin}
      isGuest={session.isGuest}
    />
  );
}
