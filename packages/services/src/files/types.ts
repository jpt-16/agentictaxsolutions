import type { FileKind } from "./validate";

/** A file that has been validated, scanned and written to storage, and is ready to be recorded against a submission. */
export interface StoredFile {
  id: string;
  name: string;
  kind: FileKind;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  scanner: string;
  scannedAt: Date;
}
