import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, CircleAlert, Copy, Loader } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { outcomeInfo, serverStatusMeta } from '@/lib/format';
import type { Server } from '@/types';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-subtle-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function OutcomeBadge({ outcome, className }: { outcome: string; className?: string }) {
  const info = outcomeInfo(outcome);
  return <Badge tone={info.tone} dot className={className}>{info.label}</Badge>;
}

export function ServerStatusBadge({ status }: { status: Server['status'] }) {
  const info = serverStatusMeta[status];
  return (
    <Badge tone={info.tone} dot={status !== 'pending'}>
      {status === 'pending' && <Loader className="animate-spin" />}
      {info.label}
    </Badge>
  );
}

export function StatusDot({ tone, pulse = false, className }: { tone: 'success' | 'danger' | 'idle' | 'warning'; pulse?: boolean; className?: string }) {
  const colors = {
    success: 'bg-success shadow-[0_0_0_3px_var(--success-soft)]',
    danger: 'bg-danger shadow-[0_0_0_3px_var(--danger-soft)]',
    warning: 'bg-warning shadow-[0_0_0_3px_var(--warning-soft)]',
    idle: 'bg-idle',
  } as const;
  return <span aria-hidden="true" className={cn('inline-block size-[7px] shrink-0 rounded-full', colors[tone], pulse && 'animate-pulse-soft', className)} />;
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-[5px] border bg-muted px-1.5 font-mono text-[11.5px] text-subtle-foreground', className)}>{children}</span>;
}

export async function copyText(value: string, what = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(what);
    return true;
  } catch {
    toast.error('Could not copy', { description: 'Select the text and copy it manually.' });
    return false;
  }
}

export function CopyButton({ value, label = 'Copy', toastLabel, className, size = 'icon-sm', variant = 'ghost' }: { value: string; label?: string; toastLabel?: string; className?: string; size?: 'icon-sm' | 'icon-xs' | 'sm' | 'xs'; variant?: 'ghost' | 'outline' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    if (await copyText(value, toastLabel ?? 'Copied to clipboard')) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }
  }
  const icon = copied ? <Check className="text-success-text" /> : <Copy />;
  if (size === 'sm' || size === 'xs') {
    return <Button type="button" variant={variant} size={size} className={className} onClick={() => void copy()}>{icon}{copied ? 'Copied' : label}</Button>;
  }
  return (
    <Hint label={copied ? 'Copied' : label}>
      <Button type="button" variant={variant} size={size} className={className} aria-label={label} onClick={() => void copy()}>{icon}</Button>
    </Hint>
  );
}

export function CodeBlock({ value, label = 'Copy', toastLabel, className, wrap = false }: { value: string; label?: string; toastLabel?: string; className?: string; wrap?: boolean }) {
  return (
    <div className={cn('group relative rounded-lg border bg-sunken', className)}>
      <pre className={cn('scrollbar-thin overflow-x-auto py-3 pl-3.5 pr-12 font-mono text-[12.5px] leading-relaxed text-foreground', wrap ? 'whitespace-pre-wrap break-all' : 'max-sm:whitespace-pre-wrap max-sm:[overflow-wrap:anywhere]')}>{value}</pre>
      <CopyButton value={value} label={label} toastLabel={toastLabel} className="absolute right-1.5 top-1.5 bg-sunken/80 backdrop-blur" />
    </div>
  );
}

export function InlineError({ message, className, action }: { message?: string; className?: string; action?: ReactNode }) {
  if (!message) return null;
  return (
    <div role="alert" className={cn('flex items-start gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-[13px] text-danger-text', className)}>
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-lg border bg-muted text-muted-foreground [&_svg]:size-[18px]">{icon}</div>}
      <p className="text-[13.5px] font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] items-center rounded border bg-card px-1 font-mono text-[10.5px] text-muted-foreground">{children}</kbd>;
}
