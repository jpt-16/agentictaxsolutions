import { downloadFile } from "@taxops/services";
import { getContext } from "@/lib/auth";
import { fileDeps } from "@/lib/files";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** RFC 5987 filename encoding, with an ASCII fallback; the name is display-only and already sanitized. */
function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getContext();
  if (!ctx) return Response.json({ ok: false, error: "Please sign in." }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ ok: false, error: "File not found." }, { status: 404 });
  try {
    const file = await downloadFile(ctx, fileDeps(), id);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.size),
        "Content-Disposition": contentDisposition(file.name),
        // Defence in depth: user-supplied content must never execute in our origin.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
