import { createContext, useCallback, useContext } from 'react';
import type { ReactNode } from 'react';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useResource } from '@/hooks';
import type { Member, Meta, Server } from '@/types';

interface WorkspaceValue {
  servers: Server[] | undefined;
  serversError: string;
  serversFetchedAt: number | undefined;
  reloadServers: () => void;
  members: Member[] | undefined;
  reloadMembers: () => void;
  meta: Meta | undefined;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/** Shared, polled workspace data: the sidebar, Servers page and filters all read from one 5s poll. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const servers = useResource(
    useCallback(async () => ({ list: await api.servers(), at: Date.now() }), []),
    5000,
  );
  const members = useResource(useCallback(() => (admin ? api.users() : Promise.resolve<Member[] | undefined>(undefined)), [admin]));
  const meta = useResource(api.meta);
  return (
    <WorkspaceContext.Provider
      value={{
        servers: servers.data?.list,
        serversError: servers.error,
        serversFetchedAt: servers.data?.at,
        reloadServers: servers.reload,
        members: members.data,
        reloadMembers: members.reload,
        meta: meta.data,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('WorkspaceProvider is missing');
  return context;
}
