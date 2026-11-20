import { appUrl, connect, type Connection } from "@taxops/db";

// One pool per server process (survives dev hot reloads). Connects as the restricted app role.
const g = globalThis as unknown as { __taxopsDb?: Connection };
export const conn: Connection = (g.__taxopsDb ??= connect(appUrl(), { max: 10 }));
export const db = conn.db;
