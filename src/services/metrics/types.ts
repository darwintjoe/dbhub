export interface RingBufferSnapshot<T> {
  capacity: number;
  values: T[];
}

export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly values: T[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(value: T): void {
    if (this.values.length >= this.capacity) this.values.shift();
    this.values.push(value);
  }

  toArray(): T[] {
    return [...this.values];
  }

  size(): number {
    return this.values.length;
  }

  capacitySize(): number {
    return this.capacity;
  }

  clear(): void {
    this.values.length = 0;
  }

  resize(capacity: number): void {
    const next = Math.max(1, Math.floor(capacity));
    if (next === this.capacity) return;
    // capacity is readonly; recreate not possible, so adjust stored max by mutating via any
    (this as any).capacity = next;
    while (this.values.length > next) this.values.shift();
  }
}

export interface LatencyStats {
  count: number;
  sumMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

export class LatencyTracker {
  private count = 0;
  private sumMs = 0;
  private maxMs = 0;
  private readonly values: number[] = [];
  private readonly cap: number;

  constructor(cap = 10000) {
    this.cap = cap;
  }

  record(ms: number): void {
    this.count++;
    this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    if (this.values.length >= this.cap) this.values.shift();
    this.values.push(ms);
  }

  snapshot(): LatencyStats {
    const sorted = [...this.values].sort((a, b) => a - b);
    const p = (q: number) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
      return sorted[idx] ?? 0;
    };
    return {
      count: this.count,
      sumMs: this.sumMs,
      maxMs: this.maxMs,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
    };
  }

  reset(): void {
    this.count = 0;
    this.sumMs = 0;
    this.maxMs = 0;
    this.values.length = 0;
  }
}

export interface RouteGroupStats {
  count: number;
  errors4xx: number;
  errors5xx: number;
  latency: LatencyStats;
}

export function normalizeRoutePath(p: string): string {
  // Replace UUIDs, numeric IDs, and long hex tokens.
  return p
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id");
}
