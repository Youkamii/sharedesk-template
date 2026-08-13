import { errorResponse, requireSession } from "@/lib/api";
import { resolveFolderPath } from "@/lib/folder-path";

export async function GET(req: Request) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const path = new URL(req.url).searchParams.get("path") ?? "/";
  try {
    return Response.json(await resolveFolderPath(path));
  } catch (error) {
    return errorResponse(error);
  }
}
