import { LatencyTracker, normalizeRoutePath, type LatencyStats } from "./types";

export interface RequestMetricsSnapshot {
  total: number;
  status4xx: number;
  status5xx: number;
  unauthorized: number;
  forbidden: number;
  rateLimited: number;
  latency: LatencyStats;
  routeGroups: Record<string, { count: number; errors4xx: number; errors5xx: number; latency: LatencyStats }>;
}

export class RequestMetrics {
  private total = 0;
  private status4xx = 0;
  private status5xx = 0;
  private unauthorized = 0;
  private forbidden = 0;
  private rateLimited = 0;
  private readonly latency = new LatencyTracker();
  private readonly routeGroups = new Map<string, { count: number; errors4xx: number; errors5xx: number; latency: LatencyTracker }>();
  private readonly maxGroups = 50;

  record(routeGroup: string, statusCode: number, durationMs: number): void {
    this.total++;
    if (statusCode >= 400 && statusCode < 500) this.status4xx++;
    if (statusCode >= 500) this.status5xx++;
    if (statusCode === 401) this.unauthorized++;
    if (statusCode === 403) this.forbidden++;
    if (statusCode === 429) this.rateLimited++;
    this.latency.record(durationMs);

    const group = normalizeRoutePath(routeGroup);
    let entry = this.routeGroups.get(group);
    if (!entry) {
      if (this.routeGroups.size >= this.maxGroups) return;
      entry = { count: 0, errors4xx: 0, errors5xx: 0, latency: new LatencyTracker() };
      this.routeGroups.set(group, entry);
    }
    entry.count++;
    if (statusCode >= 400 && statusCode < 500) entry.errors4xx++;
    if (statusCode >= 500) entry.errors5xx++;
    entry.latency.record(durationMs);
  }

  snapshot(): RequestMetricsSnapshot {
    const groups: RequestMetricsSnapshot["routeGroups"] = {};
    for (const [k, v] of this.routeGroups) {
      groups[k] = { count: v.count, errors4xx: v.errors4xx, errors5xx: v.errors5xx, latency: v.latency.snapshot() };
    }
    return {
      total: this.total,
      status4xx: this.status4xx,
      status5xx: this.status5xx,
      unauthorized: this.unauthorized,
      forbidden: this.forbidden,
      rateLimited: this.rateLimited,
      latency: this.latency.snapshot(),
      routeGroups: groups,
    };
  }

  reset(): void {
    this.total = 0;
    this.status4xx = 0;
    this.status5xx = 0;
    this.unauthorized = 0;
    this.forbidden = 0;
    this.rateLimited = 0;
    this.latency.reset();
    this.routeGroups.clear();
  }
}
