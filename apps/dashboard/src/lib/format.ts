import { useEffect, useState } from 'react';
import type { Outcome, Server } from '@/types';

export type Tone = 'success' | 'danger' | 'warning' | 'idle' | 'brand';

export function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export function relativeTime(value: string | number | null | undefined, now = Date.now()) {
  if (value == null) return 'Never';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 90) return 'just now'; // small clock skew between browser and gateway
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return `in ${Math.round(ahead / 86400)}d`;
  }
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(time).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function absoluteTime(value: string | null | undefined) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function shortDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const outcomeMeta: Record<Outcome, { label: string; tone: Tone }> = {
  ok: { label: 'OK', tone: 'success' },
  tool_error: { label: 'Tool error', tone: 'warning' },
  denied: { label: 'Denied', tone: 'danger' },
  timeout: { label: 'Timed out', tone: 'warning' },
  unknown: { label: 'Unknown outcome', tone: 'warning' },
  unreachable: { label: 'Unreachable', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },
  pending: { label: 'Pending', tone: 'idle' },
};

export function outcomeInfo(outcome: string) {
  return outcomeMeta[outcome as Outcome] ?? { label: outcome.replaceAll('_', ' '), tone: 'idle' as Tone };
}

export const serverStatusMeta: Record<Server['status'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  unreachable: { label: 'Unreachable', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'idle' },
  pending: { label: 'Pending', tone: 'idle' },
};

export function initials(name: string, email = '') {
  const source = name.trim() || email.split('@')[0] || '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : source.slice(0, 2);
  return letters.toUpperCase();
}

export function compactJson(value: unknown, max = 120) {
  let text: string;
  if (typeof value === 'string') {
    try { text = JSON.stringify(JSON.parse(value)); } catch { text = value; }
  } else text = JSON.stringify(value) ?? '';
  if (text === '{}' || text === 'null') return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function prettyJson(value: unknown) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2) ?? '';
}
