import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import AdminView from "./AdminView";

export default async function AdminPage() {
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
  if (!session.isAdmin) redirect("/files");
  return <AdminView adminEmail={session.email} />;
}
