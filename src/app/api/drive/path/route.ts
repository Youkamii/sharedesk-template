import { errorResponse, runWithSession } from "@/lib/api";
import { resolveFolderPath } from "@/lib/folder-path";

export async function GET(req: Request) {
  return runWithSession(null, async () => {
    const path = new URL(req.url).searchParams.get("path") ?? "/";
    try {
      return Response.json(await resolveFolderPath(path));
    } catch (error) {
      return errorResponse(error);
    }
  });
}
