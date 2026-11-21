import { revalidatePath } from "next/cache";
import { submitWithFiles } from "@taxops/services";
import { getContext } from "@/lib/auth";
import { fileDeps } from "@/lib/files";
import { errorResponse, isSameOrigin } from "@/lib/http";
import { limiter, tooMany } from "@/lib/rate-limit";
import { BodyTooLargeError, LengthRequiredError, readFormDataCapped } from "@/lib/body-limit";

export const dynamic = "force-dynamic";
const MAX_BODY = 110 * 1024 * 1024; // 100 MB of files plus multipart overhead

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
  const ctx = await getContext();
  if (!ctx) return Response.json({ ok: false, error: "Please sign in again." }, { status: 401 });
  // Each upload can queue processing and, if the company allows it, paid model calls: 10 a minute and 120 an hour per person.
  const rl = limiter("uploads", 10, 60_000).hit(ctx.session.userId);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  const rlHour = limiter("uploads-hour", 120, 3_600_000).hit(ctx.session.userId);
  if (!rlHour.ok) return tooMany(rlHour.retryAfterSec);
  let form: FormData;
  try {
    form = await readFormDataCapped(req, MAX_BODY);
  } catch (e) {
    if (e instanceof LengthRequiredError) return Response.json({ ok: false, error: e.message }, { status: 411 });
    if (e instanceof BodyTooLargeError) return Response.json({ ok: false, error: e.message }, { status: 413 });
    return Response.json({ ok: false, error: "The upload could not be read." }, { status: 400 });
  }

  try {
    const itemId = String(form.get("itemId") ?? "");
    const requestId = String(form.get("requestId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) return Response.json({ ok: false, error: "Invalid item." }, { status: 400 });
    const picked = form.getAll("files").filter((v): v is File => v instanceof File && (v.size > 0 || v.name !== ""));
    // An empty file is a mistake worth telling the person about, not something to drop silently and then report "submitted".
    const empty = picked.find((f) => f.size === 0);
    if (empty) return Response.json({ ok: false, error: `"${empty.name.slice(0, 80)}" is empty (0 bytes). Check the file and attach it again.` }, { status: 422 });
    const uploads = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) })));
    const result = await submitWithFiles(ctx, fileDeps(), itemId, { note: String(form.get("note") ?? "") }, uploads);
    revalidatePath("/"); revalidatePath("/requests");
    if (/^[0-9a-f-]{36}$/i.test(requestId)) revalidatePath(`/requests/${requestId}`);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
