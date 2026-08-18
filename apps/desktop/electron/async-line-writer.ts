import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_PENDING_BYTES = 2 * 1024 * 1024;

export class AsyncLineWriter {
  private readonly pending: string[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private writeChain = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxFileBytes: number,
    private readonly maxFiles: number,
    private readonly flushDelayMs = 200,
  ) {}

  write(line: string): void {
    const bytes = Buffer.byteLength(line, "utf8");
    while (this.pendingBytes + bytes > MAX_PENDING_BYTES && this.pending.length > 0) {
      const dropped = this.pending.shift();
      if (dropped === undefined) break;
      this.pendingBytes -= Buffer.byteLength(dropped, "utf8");
    }
    if (bytes > MAX_PENDING_BYTES) return;
    this.pending.push(line);
    this.pendingBytes += bytes;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, this.flushDelayMs);
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.length === 0) return this.writeChain;
    const batch = this.pending.splice(0).join("");
    this.pendingBytes = 0;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.writeBatch(batch));
    return this.writeChain;
  }

  private async writeBatch(batch: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const nextBytes = Buffer.byteLength(batch, "utf8");
    await this.rotateIfNeeded(nextBytes);
    await appendFile(this.filePath, batch, "utf8");
  }

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    const currentSize = await stat(this.filePath).then((value) => value.size).catch(() => 0);
    if (currentSize + nextBytes <= this.maxFileBytes) return;
    const oldest = `${this.filePath}.${this.maxFiles - 1}`;
    await rm(oldest, { force: true }).catch(() => undefined);
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`)
        .catch(() => undefined);
    }
    await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
  }
}
