type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';
type RateLimitWindow = { label: string; usedPercent?: number; resetsAt?: number; status?: RateLimitStatus };
export type RateLimitUsage = 'unknown' | { observedAt: string; windows: RateLimitWindow[] };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validNumber(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function normalizeWindow(label: string, usedPercent: unknown, resetsAt: unknown, status?: RateLimitStatus): RateLimitWindow | undefined {
  const result: RateLimitWindow = { label };
  if (validNumber(usedPercent, 0, 100)) result.usedPercent = usedPercent;
  if (validNumber(resetsAt, 1, 8_640_000_000_000)) result.resetsAt = resetsAt;
  if (status) result.status = status;
  return result.usedPercent !== undefined || result.resetsAt !== undefined || result.status ? result : undefined;
}

export function restoreRateLimitUsage(value: unknown): RateLimitUsage {
  const { observedAt, windows } = object(value);
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) ||
      !Array.isArray(windows) || windows.length === 0 || windows.length > 64) return 'unknown';
  const normalized = windows.flatMap(item => {
    const { label, usedPercent, resetsAt, status } = object(item);
    if (typeof label !== 'string' || !label || label.length > 256) return [];
    const validStatus = status === 'allowed' || status === 'allowed_warning' || status === 'rejected' ? status : undefined;
    const result = normalizeWindow(label, usedPercent, resetsAt, validStatus);
    return result ? [result] : [];
  });
  return normalized.length ? { observedAt, windows: normalized } : 'unknown';
}

export function codexRateLimits(params: unknown): RateLimitWindow[] {
  const update = object(params);
  const buckets = Object.values(object(update.rateLimitsByLimitId)).slice(0, 32);
  const snapshots = buckets.length ? buckets : [update.rateLimits];
  return snapshots.flatMap((snapshot, index) => {
    const limit = object(snapshot);
    const prefix = snapshots.length === 1 || limit.limitId === 'codex' ? '' : `枠 ${index + 1} · `;
    return (['primary', 'secondary'] as const).flatMap((key, position) => {
      const data = object(limit[key]);
      const duration = data.windowDurationMins;
      const label = validNumber(duration, 1) ? duration % 1440 === 0 ? `${duration / 1440}日枠` : duration % 60 === 0 ? `${duration / 60}時間枠` : `${duration}分枠` : position === 0 ? '主枠' : '副枠';
      const value = normalizeWindow(prefix + label, data.usedPercent, data.resetsAt);
      return value ? [value] : [];
    });
  });
}

export function claudeRateLimit(info: unknown): RateLimitWindow | undefined {
  const data = object(info);
  const status = data.status;
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return undefined;
  const label = data.rateLimitType === 'five_hour' ? '5時間枠' : data.rateLimitType === 'seven_day' ? '7日枠' : '利用枠';
  return normalizeWindow(label, validNumber(data.utilization, 0, 1) ? data.utilization * 100 : undefined, data.resetsAt, status);
}

export function claudeUsageReport(report: unknown): RateLimitWindow[] {
  const limits = object(object(report).rate_limits).limits;
  if (!Array.isArray(limits)) return [];
  return limits.slice(0, 32).flatMap(row => {
    const meter = object(row);
    const scope = object(meter.scope);
    const labels = [object(scope.model).display_name, object(scope.surface).display_name]
      .filter((label): label is string => typeof label === 'string' && label.length > 0 && label.length <= 100);
    const period = meter.kind === 'session' ? '5時間枠' : meter.group === 'weekly' ? '7日枠' : '利用枠';
    const label = [period, ...labels].join(' · ');
    const resetsAt = typeof meter.resets_at === 'string' ? Date.parse(meter.resets_at) / 1000 : undefined;
    const value = normalizeWindow(label, meter.percent, resetsAt);
    return value ? [value] : [];
  });
}
