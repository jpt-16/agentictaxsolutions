import net from "node:net";

export interface ScanResult { clean: boolean; signature?: string }
export interface Scanner { readonly name: string; scan(bytes: Buffer): Promise<ScanResult> }

export class ScanUnavailableError extends Error {
  constructor(message = "The virus scanner is unavailable.") {
    super(message);
    this.name = "ScanUnavailableError";
  }
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Development stand-in: only catches the industry-standard EICAR test string. NOT a real scanner. */
export class EicarScanner implements Scanner {
  readonly name = "eicar-dev";
  async scan(bytes: Buffer): Promise<ScanResult> {
    return bytes.includes(EICAR) ? { clean: false, signature: "Eicar-Test-Signature" } : { clean: true };
  }
}

/** ClamAV over the clamd INSTREAM protocol. Fails CLOSED: any error means the file is not accepted. */
export class ClamdScanner implements Scanner {
  readonly name = "clamav";
  constructor(private readonly host: string, private readonly port = 3310, private readonly timeoutMs = 30_000) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = "";
      const fail = () => { socket.destroy(); reject(new ScanUnavailableError()); };
      socket.setTimeout(this.timeoutMs, fail);
      socket.on("error", fail);
      socket.on("data", (d) => { response += d.toString("utf8"); });
      socket.on("end", () => {
        const text = response.replace(/\0/g, "").trim();
        if (/stream: OK$/.test(text)) return resolve({ clean: true });
        const m = /stream: (.+) FOUND$/.exec(text);
        if (m) return resolve({ clean: false, signature: m[1] });
        reject(new ScanUnavailableError());
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let off = 0; off < bytes.length; off += 64 * 1024) {
          const chunk = bytes.subarray(off, off + 64 * 1024);
          const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
          socket.write(len); socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
  }
}

/** Production must have a real scanner; development may fall back to the EICAR stub. */
export function buildScanner(env: Record<string, string | undefined> = process.env): Scanner {
  if (env.CLAMAV_HOST) return new ClamdScanner(env.CLAMAV_HOST, Number(env.CLAMAV_PORT ?? 3310));
  if (env.NODE_ENV === "production") throw new Error("CLAMAV_HOST must be set in production: uploads are refused without a malware scanner.");
  return new EicarScanner();
}
