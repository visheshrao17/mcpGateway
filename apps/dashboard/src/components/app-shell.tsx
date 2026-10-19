import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Activity, ChevronRight, ChevronsUpDown, KeyRound, LogOut, Menu, MessageSquare, Monitor, Moon, Server, Sun, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { errorMessage } from '@/hooks';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useWorkspace, WorkspaceProvider } from '@/lib/workspace';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Hint } from '@/components/ui/tooltip';

export function AppShell() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}

const titles: Record<string, { section: string; title: string }> = {
  servers: { section: 'Workspace', title: 'Servers' },
  keys: { section: 'Workspace', title: 'API keys' },
  audit: { section: 'Workspace', title: 'Audit log' },
  chat: { section: 'Workspace', title: 'Chat' },
  members: { section: 'Admin', title: 'Members' },
};

const ShellContext = createContext<{ openNav: () => void }>({ openNav: () => {} });
/** Lets full-bleed pages (Chat) render their own header with the mobile menu button. */
export function useShell() { return useContext(ShellContext); }

function Shell() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [location.pathname]);
  const segment = location.pathname.split('/')[1] ?? '';
  const crumb = titles[segment] ?? titles.servers!;
  useEffect(() => { document.title = `${crumb.title} · urumi`; }, [crumb.title]);
  const fullBleed = segment === 'chat';
  return (
    <ShellContext.Provider value={{ openNav: () => setOpen(true) }}>
    <div className="flex h-dvh overflow-hidden bg-background">
      <a href="#main" className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
      <aside className="hidden w-[232px] shrink-0 border-r bg-card md:flex md:flex-col">
        <SidebarBody />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation and account</SheetDescription>
          <SidebarBody />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={cn('flex h-[52px] shrink-0 items-center gap-2 border-b bg-card px-3 md:px-6', fullBleed && 'hidden')}>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation" onClick={() => setOpen(true)}>
            <Menu className="size-4" />
          </Button>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
            <span>{crumb.section}</span>
            <ChevronRight className="size-3.5" aria-hidden="true" />
            <span className="truncate font-medium text-foreground" aria-current="page">{crumb.title}</span>
          </nav>
        </header>
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none scrollbar-thin">
          <Outlet />
        </main>
      </div>
    </div>
    </ShellContext.Provider>
  );
}

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1240px] px-4 py-6 md:px-8 md:py-7', className)}>{children}</div>;
}

function SidebarBody() {
  const { user } = useAuth();
  const { servers, members } = useWorkspace();
  const admin = user?.role === 'admin';
  const unhealthy = servers?.filter(server => server.enabled && server.status === 'unreachable').length ?? 0;
  return (
    <div className="flex h-full flex-col px-2.5 py-3">
      <div className="flex items-center gap-2.5 px-2 pb-3.5 pt-1.5">
        <div className="grid size-[26px] place-items-center rounded-[7px] bg-foreground text-[14px] font-semibold tracking-[-0.02em] text-background">u</div>
        <div className="leading-tight">
          <div className="text-[13.5px] font-semibold tracking-[-0.01em]">urumi</div>
          <div className="text-[11.5px] text-muted-foreground">MCP gateway</div>
        </div>
      </div>
      <nav aria-label="Main navigation" className="flex flex-col gap-px">
        <NavItem to="/servers" icon={<Server />} label="Servers">
          {unhealthy > 0 && (
            <Hint label={`${unhealthy} enabled ${unhealthy === 1 ? 'server is' : 'servers are'} unreachable`}>
              <span className="ml-auto size-1.5 rounded-full bg-danger" role="img" aria-label={`${unhealthy} unreachable`} />
            </Hint>
          )}
        </NavItem>
        <NavItem to="/keys" icon={<KeyRound />} label="API keys" />
        <NavItem to="/audit" icon={<Activity />} label="Audit log" />
        <NavItem to="/chat" icon={<MessageSquare />} label="Chat" />
        {admin && (
          <>
            <div className="px-2.5 pb-1.5 pt-3.5 text-[11px] font-medium text-muted-foreground">Admin</div>
            <NavItem to="/members" icon={<Users />} label="Members">
              {members && <span className="tabular ml-auto text-[11.5px] text-muted-foreground">{members.length}</span>}
            </NavItem>
          </>
        )}
      </nav>
      <div className="mt-auto flex flex-col gap-2.5 border-t px-1 pt-2.5">
        <ThemeToggle />
        <UserMenu />
      </div>
    </div>
  );
}

function NavItem({ to, icon, label, children }: { to: string; icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(
        'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium text-subtle-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35 [&>svg]:size-4 [&>svg]:shrink-0',
        isActive && 'bg-nav-active text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
      {children}
    </NavLink>
  );
}

const themeOptions: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
  { value: 'system', label: 'System', icon: <Monitor /> },
];

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 rounded-[7px] border bg-muted p-0.5">
      {themeOptions.map(option => (
        <Hint key={option.value} label={`${option.label} theme`}>
          <button
            type="button"
            role="radio"
            aria-checked={preference === option.value}
            aria-label={`${option.label} theme`}
            onClick={() => setPreference(option.value)}
            className={cn(
              'grid h-[26px] place-items-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35 [&>svg]:size-3.5',
              preference === option.value && 'bg-card text-foreground shadow-xs dark:bg-[#2a2a2e]',
            )}
          >
            {option.icon}
          </button>
        </Hint>
      ))}
    </div>
  );
}

function UserMenu() {
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  async function logout() {
    setBusy(true);
    try {
      await api.logout();
      setUser(null);
    } catch (err) {
      toast.error('Could not sign out', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/35 data-[state=open]:bg-accent" aria-label="Account menu">
          <Avatar name={user.name} email={user.email} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-medium">{user.name || user.email}</div>
            <div className="truncate text-[11.5px] text-muted-foreground">{user.email}</div>
          </div>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
        <DropdownMenuLabel className="flex items-center gap-2.5">
          <Avatar name={user.name} email={user.email} className="size-8" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate font-medium">{user.name || user.email}</div>
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          </div>
          <Badge tone={user.role === 'admin' ? 'brand' : 'outline'} className="capitalize">{user.role}</Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={event => { event.preventDefault(); void logout(); }}>
          <LogOut />
          {busy ? 'Signing out…' : 'Log out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
