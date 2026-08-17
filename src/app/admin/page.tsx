import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";
import AdminView from "./AdminView";

export default async function AdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
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
  return <AdminView locale={locale} />;
}
