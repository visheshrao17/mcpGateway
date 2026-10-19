import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Loader } from 'lucide-react';
import { useAuth } from './auth';
import { AppShell } from './components/app-shell';
import { AuditPage } from './pages/AuditPage';
import { InvitePage, LoginPage } from './pages/AuthPages';
import { KeysPage } from './pages/KeysPage';
import { MembersPage } from './pages/MembersPage';
import { ServersPage } from './pages/ServersPage';

// Chat pulls in the Markdown renderer; load it on demand to keep the first paint small.
const ChatPage = lazy(() => import('./pages/ChatPage').then(module => ({ default: module.ChatPage })));
function ChatFallback() {
  return <div className="grid h-full place-items-center text-muted-foreground" role="status" aria-label="Loading chat"><Loader className="size-4 animate-spin" /></div>;
}

function Protected() {
  const { user } = useAuth();
  const location = useLocation();
  return user ? <AppShell /> : <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}
function AdminOnly() {
  const { user } = useAuth();
  return user?.role === 'admin' ? <MembersPage /> : <Navigate to="/servers" replace />;
}
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route element={<Protected />}>
        <Route index element={<Navigate to="/servers" replace />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="members" element={<AdminOnly />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="chat/:conversationId?" element={<Suspense fallback={<ChatFallback />}><ChatPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/servers" replace />} />
      </Route>
    </Routes>
  );
}
