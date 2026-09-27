/** 一个极简并发闸门，避免 8 个 AI 同时打爆供应商的速率限制。 */
export class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }

  get queueLength(): number {
    return this.waiting.length;
  }

  /** 返回一个 release 函数，务必在 finally 里调用 */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.available += 1;
  }
}
