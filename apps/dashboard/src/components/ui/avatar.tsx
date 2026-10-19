import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';

const palettes = [
  'from-teal-300 to-teal-700',
  'from-sky-300 to-indigo-600',
  'from-amber-300 to-orange-600',
  'from-rose-300 to-pink-600',
  'from-violet-300 to-purple-700',
  'from-lime-300 to-emerald-700',
];

export function Avatar({ name, email = '', className }: { name: string; email?: string; className?: string }) {
  const seed = [...(email || name)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (
    <span aria-hidden="true" className={cn('grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white', palettes[seed % palettes.length], className)}>
      {initials(name, email)}
    </span>
  );
}
