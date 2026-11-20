import "server-only";
import path from "node:path";
import { buildScanner, LocalStorage, type FileDeps } from "@taxops/services";

// Dev: local disk + EICAR stub. Production must provide a real scanner (CLAMAV_HOST) and object storage.
// Cached on globalThis so dev hot-reloads reuse one instance.
const g = globalThis as unknown as { __taxopsFiles?: FileDeps };
export function fileDeps(): FileDeps {
  return (g.__taxopsFiles ??= {
    storage: new LocalStorage(process.env.STORAGE_DIR ?? path.resolve(process.cwd(), "../../.storage")),
    scanner: buildScanner(),
  });
}
