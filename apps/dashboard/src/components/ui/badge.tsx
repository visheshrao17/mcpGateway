import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2 text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        success: 'bg-success-soft text-success-text',
        danger: 'bg-danger-soft text-danger-text',
        warning: 'bg-warning-soft text-warning-text',
        idle: 'border-border bg-idle-soft text-idle-text',
        brand: 'bg-brand-soft text-brand-text',
        outline: 'border-border text-subtle-foreground',
        neutral: 'bg-secondary text-subtle-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({ className, tone, dot = false, children, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
