import { revalidatePath } from "next/cache";
import { submitWithFiles } from "@taxops/services";
import { getContext } from "@/lib/auth";
import { fileDeps } from "@/lib/files";
import { errorResponse, isSameOrigin } from "@/lib/http";

export const dynamic = "force-dynamic";
const MAX_BODY = 110 * 1024 * 1024; // 100 MB of files plus multipart overhead

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
  const ctx = await getContext();
  if (!ctx) return Response.json({ ok: false, error: "Please sign in again." }, { status: 401 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return Response.json({ ok: false, error: "The upload is too large." }, { status: 413 });

  try {
    const form = await req.formData();
    const itemId = String(form.get("itemId") ?? "");
    const requestId = String(form.get("requestId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) return Response.json({ ok: false, error: "Invalid item." }, { status: 400 });
    const uploads = await Promise.all(
      form.getAll("files").filter((v): v is File => v instanceof File && v.size > 0)
        .map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) })),
    );
    const result = await submitWithFiles(ctx, fileDeps(), itemId, { note: String(form.get("note") ?? "") }, uploads);
    revalidatePath("/"); revalidatePath("/requests");
    if (/^[0-9a-f-]{36}$/i.test(requestId)) revalidatePath(`/requests/${requestId}`);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
