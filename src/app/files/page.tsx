import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import {
  getUpdateWorkflowUrl,
  resolveUpdateRepository,
} from "@/lib/update-repository";
import { isOwnerRegistryConfigured } from "@/lib/owner-registry";
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
  const updateRepository = session.isAdmin
    ? resolveUpdateRepository()
    : null;
  const updateWorkflowUrl = updateRepository?.repository
    ? getUpdateWorkflowUrl(updateRepository.repository)
    : null;
  return (
    <FilesView
      userName={session.name}
      userEmail={session.email}
      isAdmin={session.isAdmin}
      isGuest={session.isGuest}
      canSendFeedback={!session.isGuest && isOwnerRegistryConfigured()}
      updateWorkflowUrl={updateWorkflowUrl}
    />
  );
}
