import "server-only";
import { buildScanner, LocalStorage, resolveStorageDir, type FileDeps } from "@taxops/services";

// Dev: local disk + EICAR stub. Production must provide a real scanner (CLAMAV_HOST) and object storage.
// Cached on globalThis so dev hot-reloads reuse one instance.
const g = globalThis as unknown as { __taxopsFiles?: FileDeps };
export function fileDeps(): FileDeps {
  return (g.__taxopsFiles ??= {
    storage: new LocalStorage(resolveStorageDir()),
    scanner: buildScanner(),
  });
}
