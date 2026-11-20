import { createHash } from "node:crypto";
import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import { unzipSync } from "fflate";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_SUBMISSION = 10;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export class UploadRejectedError extends Error {
  constructor(message: string, readonly reasons: { file: string; reason: string }[] = []) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

export type FileKind = "xlsx" | "csv" | "pdf" | "docx" | "txt" | "png" | "jpg";

const TYPES: Record<FileKind, { ext: string[]; mime: string }> = {
  xlsx: { ext: ["xlsx"], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  csv: { ext: ["csv"], mime: "text/csv" },
  pdf: { ext: ["pdf"], mime: "application/pdf" },
  docx: { ext: ["docx"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  txt: { ext: ["txt"], mime: "text/plain" },
  png: { ext: ["png"], mime: "image/png" },
  jpg: { ext: ["jpg", "jpeg"], mime: "image/jpeg" },
};
const REJECT_HINTS: Record<string, string> = {
  xls: "Legacy .xls files can hide macros and cannot be inspected. Save as .xlsx and upload again.",
  xlsm: "Macro-enabled workbooks are not accepted. Save as .xlsx (without macros).",
  xlsb: "Binary workbooks are not accepted. Save as .xlsx.",
  docm: "Macro-enabled documents are not accepted. Save as .docx.",
  doc: "Legacy .doc files are not accepted. Save as .docx or PDF.",
};

export interface ValidatedFile { safeName: string; kind: FileKind; contentType: string; size: number; sha256: string }

/** Display-only name: no paths, control characters or bidi tricks. Never used to build a filesystem path. */
export function sanitizeFileName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(-200);
}

const startsWith = (b: Buffer, sig: number[]) => sig.every((v, i) => b[i] === v);

function inspectZip(bytes: Buffer, required: string, label: string) {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) throw new Error(`This ${label} is password-protected or in an old format and cannot be scanned. Remove the password and re-save as .${label.toLowerCase()}.`);
    throw new Error(`The content is not a valid ${label} file.`);
  }
  const names: string[] = [];
  let total = 0;
  try {
    // The filter sees each entry's declared sizes WITHOUT decompressing it, so a zip bomb cannot exhaust memory here.
    unzipSync(new Uint8Array(bytes), { filter: (f) => { names.push(f.name); total += f.originalSize; return false; } });
  } catch {
    throw new Error(`The ${label} file is corrupt.`);
  }
  if (names.length > 5000) throw new Error("The file contains too many parts.");
  if (total > 250 * 1024 * 1024 || total > bytes.length * 200) throw new Error("The file expands to an unsafe size (possible decompression bomb).");
  if (!names.includes(required)) throw new Error(`The content is not a valid ${label} file.`);
  if (names.some((n) => /vbaProject\.bin$|\/macros?\/|activeX\/|\.exe$|\.dll$/i.test(n))) throw new Error("Files containing macros or embedded executables are not accepted.");
  if (zipXmlDeclaresDtd(bytes)) throw new Error("This file contains XML document type definitions, which are not accepted. Re-save it from Excel or Word and upload again.");
}

/**
 * Office files are ZIPs of XML. A DTD (`<!DOCTYPE`/`<!ENTITY`) has no legitimate use in them and is how XML entity-expansion
 * ("billion laughs") and external-entity attacks start, so refuse them at the door. Only a bounded PREFIX of each XML part is
 * inflated (a DTD must appear before the root element), so this check cannot itself be used as a decompression bomb.
 */
export function zipXmlDeclaresDtd(bytes: Buffer): boolean {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > bytes.length) return false;
  const entries = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries && p + 46 <= bytes.length; i++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(p + 10);
    const nameLen = bytes.readUInt16LE(p + 28), extraLen = bytes.readUInt16LE(p + 30), commentLen = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.(xml|rels|vml)$/i.test(name) || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, Math.min(bytes.length, start + 16 * 1024));
    let head: Buffer;
    try {
      head = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: 4 * 1024 * 1024 }) : Buffer.alloc(0);
    } catch { head = Buffer.alloc(0); }
    if (/<!DOCTYPE|<!ENTITY/i.test(head.subarray(0, 64 * 1024).toString("latin1"))) return true;
  }
  return false;
}

function inspectPdf(bytes: Buffer) {
  if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new Error("The content is not a valid PDF.");
  const text = bytes.toString("latin1");
  if (/\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(text)) throw new Error("PDFs with scripts, launch actions or embedded files are not accepted.");
}

function inspectText(bytes: Buffer) {
  if (bytes.includes(0)) throw new Error("The content is not a text file.");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("The file must be UTF-8 encoded text."); }
}

export function validateUpload(name: string, bytes: Buffer): ValidatedFile {
  const safeName = sanitizeFileName(name);
  if (!safeName) throw new Error("The file needs a name.");
  if (bytes.length === 0) throw new Error("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const ext = (safeName.includes(".") ? safeName.split(".").pop()! : "").toLowerCase();
  const kind = (Object.keys(TYPES) as FileKind[]).find((k) => TYPES[k].ext.includes(ext));
  if (!kind) throw new Error(REJECT_HINTS[ext] ?? `.${ext || "(none)"} files are not accepted. Allowed: xlsx, csv, pdf, docx, txt, png, jpg.`);

  switch (kind) {
    case "xlsx": inspectZip(bytes, "xl/workbook.xml", "XLSX"); break;
    case "docx": inspectZip(bytes, "word/document.xml", "DOCX"); break;
    case "pdf": inspectPdf(bytes); break;
    case "csv": case "txt": inspectText(bytes); break;
    case "png": if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw new Error("The content is not a valid PNG."); break;
    case "jpg": if (!startsWith(bytes, [0xff, 0xd8, 0xff])) throw new Error("The content is not a valid JPEG."); break;
  }
  return { safeName, kind, contentType: TYPES[kind].mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export const isPreviewable = (kind: string) => kind === "xlsx" || kind === "csv";
export const kindOfContentType = (ct: string): FileKind | null =>
  (Object.keys(TYPES) as FileKind[]).find((k) => TYPES[k].mime === ct) ?? null;
