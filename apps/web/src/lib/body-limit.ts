/**
 * Reads a request body with a HARD byte cap, counting bytes as they stream in. The Content-Length header alone is not enough:
 * it can be absent (chunked uploads) or wrong, and \`req.formData()\` would otherwise buffer an unbounded body in memory.
 */
export class BodyTooLargeError extends Error {
  constructor() { super("The upload is too large."); this.name = "BodyTooLargeError"; }
}
export class LengthRequiredError extends Error {
  constructor() { super("Uploads must declare their size."); this.name = "LengthRequiredError"; }
}

export async function readFormDataCapped(req: Request, maxBytes: number): Promise<FormData> {
  const declared = req.headers.get("content-length");
  if (declared === null) throw new LengthRequiredError();
  if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return new FormData();
  let seen = 0;
  const capped = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) { controller.error(new BodyTooLargeError()); return; }
      controller.enqueue(chunk);
    },
  }));
  try {
    return await new Response(capped, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch (e) {
    if (e instanceof BodyTooLargeError || (e as Error)?.cause instanceof BodyTooLargeError || seen > maxBytes) throw new BodyTooLargeError();
    throw e;
  }
}
