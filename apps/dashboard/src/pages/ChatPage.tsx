import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowUp, Check, ChevronRight, CircleAlert, History, Loader, LoaderCircle, Menu, MessageSquare, Plus, RefreshCw, Search, Sparkles, SquarePen, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api, streamChat } from '@/api';
import { errorMessage, useResource } from '@/hooks';
import { useShell } from '@/components/app-shell';
import { EmptyState, InlineError, OutcomeBadge } from '@/components/common';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Hint } from '@/components/ui/tooltip';
import { clock, compactJson, formatDuration, outcomeInfo, prettyJson, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace';
import type { ChatEvent, ChatMessage, Conversation, Outcome } from '@/types';

const NEW = '__new__';
const EXAMPLES = ["What orders came in today?", "Convert today's revenue to EUR", "Save a note summarising today's sales"];
const STOPPED = 'Stopped. Tool calls that already ran are listed above.';

interface Step {
  id: string;
  name: string;
  arguments: unknown;
  state: 'running' | 'done';
  outcome?: Outcome;
  duration_ms?: number;
  result_preview?: unknown;
  startedAt: number;
}
interface Turn {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  steps: Step[];
  status: 'done' | 'streaming' | 'error' | 'stopped';
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  prompt?: string;
}
type Threads = Record<string, Turn[]>;

let counter = 0;
const uid = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

function fromHistory(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: uid(), role: 'user', content: message.content, steps: [], status: 'done' });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const steps: Step[] = (message.tool_calls ?? []).map((call, index) => ({
      id: `${turns.length}-${index}`, name: call.name, arguments: call.arguments, state: 'done',
      outcome: call.outcome, duration_ms: call.duration_ms, result_preview: call.result_preview, startedAt: 0,
    }));
    const last = turns[turns.length - 1];
    if (last?.role === 'assistant') {
      last.steps.push(...steps);
      if (message.content) last.content = last.content ? `${last.content}\n\n${message.content}` : message.content;
      if (message.content === STOPPED) last.status = 'stopped';
    } else {
      turns.push({ key: uid(), role: 'assistant', content: message.content, steps, status: message.content === STOPPED ? 'stopped' : 'done' });
    }
  }
  // A turn that was stopped or interrupted can end with tool calls but no saved reply.
  for (const turn of turns) if (turn.role === 'assistant' && !turn.content) turn.status = 'stopped';
  return turns;
}

function groupConversations(list: Conversation[], now: number) {
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 86_400_000;
  const groups: { label: string; items: Conversation[] }[] = [
    { label: 'Today', items: [] }, { label: 'Yesterday', items: [] }, { label: 'Earlier', items: [] },
  ];
  for (const item of list) {
    const time = Date.parse(item.updated_at);
    groups[time >= today ? 0 : time >= yesterday ? 1 : 2]!.items.push(item);
  }
  return groups.filter(group => group.items.length);
}

export function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { meta, servers } = useWorkspace();
  const viewKey = conversationId ?? NEW;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;

  const conversations = useResource(api.conversations);
  const [threads, setThreads] = useState<Threads>({ [NEW]: [] });
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<{ key: string; controller: AbortController } | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const [unavailable, setUnavailable] = useState('');
  const [draft, setDraft] = useState('');
  const [railOpen, setRailOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reloadRail = conversations.reload;

  // Load a past conversation the first time it is opened.
  const hasThread = !!threads[viewKey];
  useEffect(() => {
    if (viewKey === NEW || hasThread) return;
    let active = true;
    setLoadErrors(old => { const { [viewKey]: _drop, ...rest } = old; void _drop; return rest; });
    api.conversation(viewKey)
      .then(result => { if (active) setThreads(old => (old[viewKey] ? old : { ...old, [viewKey]: fromHistory(result.messages) })); })
      .catch(err => { if (active) setLoadErrors(old => ({ ...old, [viewKey]: err instanceof ApiError && err.status === 404 ? 'This conversation does not exist or belongs to someone else.' : errorMessage(err) })); });
    return () => { active = false; };
  }, [viewKey, hasThread]);

  useEffect(() => { setRailOpen(false); }, [viewKey]);
  useEffect(() => () => { runningRef.current?.controller.abort(); }, []);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || runningRef.current) return;
    let key = viewKeyRef.current;
    const controller = new AbortController();
    const assistantKey = uid();
    const userTurn: Turn = { key: uid(), role: 'user', content: message, steps: [], status: 'done' };
    const assistantTurn: Turn = { key: assistantKey, role: 'assistant', content: '', steps: [], status: 'streaming', startedAt: Date.now(), prompt: message };
    setThreads(old => ({ ...old, [key]: [...(old[key] ?? []), userTurn, assistantTurn] }));
    const next = { key, controller };
    runningRef.current = next;
    setRunning(next);
    setDraft('');

    const patch = (update: (turn: Turn) => Turn) => setThreads(old => ({
      ...old,
      [key]: (old[key] ?? []).map(turn => (turn.key === assistantKey ? update(turn) : turn)),
    }));

    const onEvent = (event: ChatEvent) => {
      switch (event.type) {
        case 'conversation': {
          if (key !== NEW) break;
          const id = event.conversation_id;
          setThreads(old => {
            const { [NEW]: moving = [], ...rest } = old;
            return { ...rest, [NEW]: [], [id]: moving };
          });
          key = id;
          const moved = { key: id, controller };
          runningRef.current = moved;
          setRunning(moved);
          if (viewKeyRef.current === NEW) navigate(`/chat/${id}`, { replace: true });
          reloadRail();
          break;
        }
        case 'tool_call_started':
          patch(turn => ({ ...turn, steps: [...turn.steps, { id: event.id, name: event.name, arguments: event.arguments, state: 'running', startedAt: Date.now() }] }));
          break;
        case 'tool_call_finished':
          patch(turn => {
            const exists = turn.steps.some(step => step.id === event.id);
            const finished: Step = { id: event.id, name: event.name, arguments: event.arguments, state: 'done', outcome: event.outcome, duration_ms: event.duration_ms, result_preview: event.result_preview, startedAt: 0 };
            return { ...turn, steps: exists ? turn.steps.map(step => (step.id === event.id ? { ...finished, startedAt: step.startedAt } : step)) : [...turn.steps, finished] };
          });
          break;
        case 'message':
          patch(turn => ({ ...turn, content: event.content }));
          break;
        case 'error':
          patch(turn => ({ ...turn, error: event.message }));
          break;
        case 'done':
          patch(turn => ({
            ...turn,
            content: event.reply || turn.content,
            status: turn.error ? 'error' : 'done',
            finishedAt: Date.now(),
            steps: turn.steps.length ? turn.steps : event.tool_calls.map((call, index) => ({ id: String(index), name: call.name, arguments: call.arguments, state: 'done', outcome: call.outcome, duration_ms: call.duration_ms, result_preview: call.result_preview, startedAt: 0 })),
          }));
          break;
        default:
          break;
      }
    };

    try {
      await streamChat(message, key === NEW ? undefined : key, onEvent, controller.signal);
      patch(turn => (turn.status === 'streaming'
        ? { ...turn, status: turn.error || !turn.content ? 'error' : 'done', error: turn.error ?? (turn.content ? undefined : 'The gateway closed the stream before the reply arrived.'), finishedAt: Date.now() }
        : turn));
    } catch (err) {
      if (controller.signal.aborted) {
        patch(turn => ({ ...turn, status: 'stopped', content: turn.content || STOPPED, finishedAt: Date.now(), steps: turn.steps.map(step => (step.state === 'running' ? { ...step, state: 'done', outcome: 'unknown' } : step)) }));
      } else {
        if (err instanceof ApiError && err.status === 503) setUnavailable(err.message);
        patch(turn => ({ ...turn, status: 'error', error: errorMessage(err), finishedAt: Date.now() }));
      }
    } finally {
      runningRef.current = null;
      setRunning(null);
      reloadRail();
      if (key !== NEW && viewKeyRef.current !== key) toast.success('Chat reply ready', { action: { label: 'Open', onClick: () => navigate(`/chat/${key}`) } });
    }
  }, [navigate, reloadRail]);

  function stop() {
    running?.controller.abort();
  }
  function newChat() {
    setThreads(old => ({ ...old, [NEW]: running?.key === NEW ? old[NEW] ?? [] : [] }));
    navigate('/chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const turns = threads[viewKey];
  const loadError = loadErrors[viewKey];
  const notConfigured = unavailable || (meta && !meta.llm_model ? 'Chat is not configured on this gateway. An administrator needs to set LLM_API_KEY and LLM_MODEL.' : '');
  const thisRunning = running?.key === viewKey;
  const otherRunning = !!running && !thisRunning;
  const title = viewKey === NEW
    ? 'New chat'
    : conversations.data?.find(item => item.id === viewKey)?.title ?? turns?.find(turn => turn.role === 'user')?.content ?? 'Conversation';
  const available = (servers ?? []).filter(server => server.enabled && server.status === 'connected');
  const toolCount = available.reduce((sum, server) => sum + server.tools.length, 0);

  const rail = (
    <ConversationRail
      conversations={conversations.data}
      error={conversations.error}
      activeKey={viewKey}
      runningKey={running?.key}
      onNew={newChat}
      onRetry={conversations.reload}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[264px] shrink-0 flex-col border-r bg-card lg:flex">{rail}</aside>
      <Sheet open={railOpen} onOpenChange={setRailOpen}>
        <SheetContent side="left" className="w-[300px] lg:hidden">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <SheetDescription className="sr-only">Your recent chat conversations</SheetDescription>
          {rail}
        </SheetContent>
      </Sheet>

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <ThreadHeader title={title} model={meta?.llm_model ?? undefined} onHistory={() => setRailOpen(true)} onNew={newChat} />
        {notConfigured && !turns?.length ? (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState
              icon={<CircleAlert />}
              title="Chat isn't configured"
              description={<>{notConfigured} <span className="block pt-1">MCP clients still work. Connect one from the API keys page.</span></>}
            />
          </div>
        ) : (
          <Thread
            turns={turns}
            loadError={loadError}
            onExample={prompt => void send(prompt)}
            onRetry={prompt => void send(prompt)}
            canSend={!running && !notConfigured}
            viewKey={viewKey}
          />
        )}
        <Composer
          inputRef={inputRef}
          value={draft}
          onChange={setDraft}
          onSend={() => void send(draft)}
          onStop={stop}
          running={thisRunning}
          blocked={otherRunning}
          disabled={!!notConfigured || (!!loadError && viewKey !== NEW)}
          status={servers ? `${available.length} ${available.length === 1 ? 'server' : 'servers'} · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} available` : ''}
        />
      </section>
    </div>
  );
}

function ThreadHeader({ title, model, onHistory, onNew }: { title: string; model?: string; onHistory: () => void; onNew: () => void }) {
  const { openNav } = useShell();
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b bg-card px-3 md:px-6">
      <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation" onClick={openNav}><Menu className="size-4" /></Button>
      <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Show conversations" onClick={onHistory}><History className="size-4" /></Button>
      <h1 className="min-w-0 flex-1 truncate pl-1 text-[13.5px] font-medium lg:pl-0">{title}</h1>
      {model && (
        <Hint label="Model used for chat replies">
          <Badge tone="outline" className="hidden max-w-[260px] sm:inline-flex" tabIndex={0}>
            <Sparkles /><span className="truncate">{model}</span>
          </Badge>
        </Hint>
      )}
      <Hint label="New chat">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="New chat" onClick={onNew}><SquarePen className="size-4" /></Button>
      </Hint>
    </header>
  );
}

function ConversationRail({ conversations, error, activeKey, runningKey, onNew, onRetry }: {
  conversations: Conversation[] | undefined; error: string; activeKey: string; runningKey?: string; onNew: () => void; onRetry: () => void;
}) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [query, setQuery] = useState('');
  const filtered = (conversations ?? []).filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = groupConversations(filtered, now);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <Button variant="outline" className="w-full" onClick={onNew}><Plus />New chat</Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="h-8 border-transparent bg-muted pl-8 text-[13px] shadow-none dark:bg-muted" />
        </div>
      </div>
      <nav aria-label="Conversations" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!conversations && !error && (
          <div className="space-y-3 px-2 pt-4">
            <Skeleton className="h-3 w-12" />
            {Array.from({ length: 5 }, (_, index) => <div key={index} className="space-y-1.5"><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3 w-1/3" /></div>)}
          </div>
        )}
        {error && !conversations && (
          <div className="px-2 pt-4 text-[13px] text-muted-foreground">
            Couldn't load conversations.
            <Button variant="link" size="xs" className="px-1" onClick={onRetry}>Retry</Button>
          </div>
        )}
        {conversations && conversations.length === 0 && (
          <p className="px-2 pt-4 text-[13px] text-muted-foreground">No conversations yet. Your chats appear here.</p>
        )}
        {conversations && conversations.length > 0 && filtered.length === 0 && (
          <p className="px-2 pt-4 text-[13px] text-muted-foreground">No conversations match “{query}”.</p>
        )}
        {groups.map(group => (
          <div key={group.label}>
            <div className="px-2 pb-1 pt-3 text-[11.5px] font-medium text-muted-foreground">{group.label}</div>
            <ul className="flex flex-col gap-px">
              {group.items.map(item => {
                const active = item.id === activeKey;
                const isRunning = item.id === runningKey;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/chat/${item.id}`)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'block w-full rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/35',
                        active && 'bg-nav-active hover:bg-nav-active',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-[13px] font-medium">
                        {isRunning && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-brand-text" aria-label="Running" />}
                        <span className="truncate">{item.title || 'Untitled'}</span>
                      </span>
                      <span className="mt-px block truncate text-xs text-muted-foreground">{isRunning ? 'Running…' : relativeTime(item.updated_at, now)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

function Thread({ turns, loadError, onExample, onRetry, canSend, viewKey }: {
  turns: Turn[] | undefined; loadError?: string; onExample: (prompt: string) => void; onRetry: (prompt: string) => void; canSend: boolean; viewKey: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    stick.current = true;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [viewKey, turns === undefined]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [turns]);
  const onScroll = () => {
    const element = scroller.current;
    if (element) stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  let body: ReactNode;
  if (loadError) {
    body = <div className="grid h-full place-items-center"><EmptyState icon={<CircleAlert />} title="Couldn't open this conversation" description={loadError} /></div>;
  } else if (!turns) {
    body = (
      <div className="space-y-7 pt-2" role="status" aria-label="Loading conversation">
        <div className="flex justify-end"><Skeleton className="h-9 w-64 rounded-2xl" /></div>
        <div className="flex gap-3"><Skeleton className="size-7 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-1/4" /><Skeleton className="h-3.5 w-11/12" /><Skeleton className="h-3.5 w-3/4" /></div></div>
        <div className="flex justify-end"><Skeleton className="h-9 w-48 rounded-2xl" /></div>
      </div>
    );
  } else if (turns.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center pb-10 text-center">
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-foreground text-background"><MessageSquare className="size-[18px]" /></div>
        <h2 className="text-lg font-semibold tracking-[-0.015em]">What would you like to do?</h2>
        <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">Ask about your data or take an action. The assistant calls your connected MCP tools and shows each step.</p>
        <div className="mt-6 grid w-full max-w-md gap-2">
          {EXAMPLES.map(prompt => (
            <button
              key={prompt}
              type="button"
              disabled={!canSend}
              onClick={() => onExample(prompt)}
              className="group flex items-center justify-between gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-left text-[13px] shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:opacity-50"
            >
              {prompt}
              <ArrowUp className="size-3.5 shrink-0 rotate-45 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <div aria-live="polite">
        {turns.map(turn => (turn.role === 'user'
          ? <UserBubble key={turn.key} content={turn.content} />
          : <AssistantTurn key={turn.key} turn={turn} onRetry={onRetry} canRetry={canSend} />))}
      </div>
    );
  }
  return (
    <div ref={scroller} onScroll={onScroll} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto h-full w-full max-w-[760px] px-4 pb-4 pt-6 md:px-7">{body}</div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="mb-6 flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] border bg-muted px-3.5 py-2 text-[14px] dark:bg-secondary sm:max-w-[78%]">{content}</div>
    </div>
  );
}

function AssistantTurn({ turn, onRetry, canRetry }: { turn: Turn; onRetry: (prompt: string) => void; canRetry: boolean }) {
  const streaming = turn.status === 'streaming';
  const anyRunning = turn.steps.some(step => step.state === 'running');
  const elapsed = turn.startedAt && turn.finishedAt ? turn.finishedAt - turn.startedAt : undefined;
  const [expanded, setExpanded] = useState(false);
  const showSteps = streaming || expanded;
  return (
    <div className="mb-7 grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <div className="grid size-7 place-items-center rounded-lg bg-foreground text-[13px] font-semibold text-background" aria-hidden="true">u</div>
      <div className="min-w-0">
        <div className="flex h-7 items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className="font-medium text-foreground">Assistant</span>
          {streaming && turn.startedAt && <LiveTimer since={turn.startedAt} />}
          {!streaming && turn.steps.length > 0 && <span>· {turn.steps.length} {turn.steps.length === 1 ? 'tool' : 'tools'}</span>}
          {!streaming && elapsed !== undefined && <span className="tabular">· {formatDuration(elapsed)}</span>}
          {turn.status === 'stopped' && <Badge tone="idle" className="h-5 text-[11px]">Stopped</Badge>}
        </div>

        {turn.steps.length > 0 && (showSteps ? (
          <StepList steps={turn.steps} live={streaming} onCollapse={streaming ? undefined : () => setExpanded(false)} />
        ) : (
          <div className="mb-2.5 mt-1 flex flex-wrap gap-1.5">
            {turn.steps.map(step => <StepChip key={step.id} step={step} onClick={() => setExpanded(true)} />)}
          </div>
        ))}

        {turn.content && turn.status !== 'stopped' && <Markdown>{turn.content}</Markdown>}
        {turn.status === 'stopped' && <p className="text-[13.5px] text-muted-foreground">{turn.content || 'No reply was recorded. This turn was stopped or interrupted.'}</p>}

        {streaming && !turn.content && (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[13px]" role="status">
            <span className="shimmer-text font-medium">{anyRunning ? 'Running tools…' : turn.steps.length ? 'Waiting for the model to write the answer…' : 'Waiting for the model…'}</span>
            <span className="text-xs text-muted-foreground">free models can take up to a minute</span>
          </div>
        )}

        {turn.error && (
          <InlineError
            className="mt-2"
            message={turn.error}
            action={turn.prompt && !streaming && (
              <Button variant="outline" size="xs" className="-my-0.5 shrink-0 bg-card" disabled={!canRetry} onClick={() => onRetry(turn.prompt!)}>
                <RefreshCw />Retry
              </Button>
            )}
          />
        )}
      </div>
    </div>
  );
}

function LiveTimer({ since }: { since: number }) {
  const now = useNow(250);
  return <span className="tabular font-mono text-xs">· {clock(now - since)}</span>;
}

function StepIcon({ step }: { step: Step }) {
  if (step.state === 'running') return <LoaderCircle className="size-3.5 animate-spin text-brand-text" aria-label="Running" />;
  const tone = outcomeInfo(step.outcome ?? 'pending').tone;
  if (tone === 'success') return <Check className="size-3.5 text-success" aria-label="Succeeded" />;
  if (tone === 'danger') return <X className="size-3.5 text-danger" aria-label="Failed" />;
  if (tone === 'warning') return <TriangleAlert className="size-3.5 text-warning" aria-label="Warning" />;
  return <Loader className="size-3.5 text-idle" aria-label="Pending" />;
}

function StepChip({ step, onClick }: { step: Step; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-7 max-w-full items-center gap-2 rounded-md border bg-card px-2.5 text-[12.5px] text-subtle-foreground shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/35" aria-label={`Show details for ${step.name}`}>
      <StepIcon step={step} />
      <span className="truncate font-mono text-foreground">{step.name}</span>
      <span className="tabular text-muted-foreground">{formatDuration(step.duration_ms)}</span>
      <ChevronRight className="size-3 text-muted-foreground" />
    </button>
  );
}

function StepList({ steps, live, onCollapse }: { steps: Step[]; live: boolean; onCollapse?: () => void }) {
  return (
    <div className="mb-3 mt-1 overflow-hidden rounded-[10px] border bg-card">
      {steps.map(step => <StepRow key={step.id} step={step} live={live} />)}
      {onCollapse && (
        <button type="button" onClick={onCollapse} className="w-full border-t px-3 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent">Hide tool calls</button>
      )}
    </div>
  );
}

function StepRow({ step, live }: { step: Step; live: boolean }) {
  const [open, setOpen] = useState(false);
  const args = useMemo(() => compactJson(step.arguments, 90), [step.arguments]);
  const done = step.state === 'done';
  const preview = done ? prettyJson(step.result_preview) : '';
  return (
    <div className="border-b last:border-0">
      <button
        type="button"
        disabled={!done}
        aria-expanded={done ? open : undefined}
        onClick={() => setOpen(value => !value)}
        className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2 text-left text-[13px] outline-none transition-colors enabled:hover:bg-accent/60 focus-visible:bg-accent/60 disabled:cursor-default"
      >
        <StepIcon step={step} />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[12.5px]">{step.name}</span>
          {args && <span className="truncate font-mono text-xs text-muted-foreground">{args}</span>}
        </span>
        <span className="flex items-center gap-2">
          {done ? <OutcomeBadge outcome={step.outcome ?? 'pending'} className="h-5 text-[11px]" /> : <Badge tone="outline" className="h-5 text-[11px]">running</Badge>}
          <span className="tabular w-12 text-right text-xs text-muted-foreground">{done ? formatDuration(step.duration_ms) : live ? <StepTimer since={step.startedAt} /> : '—'}</span>
          {done && <ChevronRight className={cn('size-3 text-muted-foreground transition-transform', open && 'rotate-90')} />}
        </span>
      </button>
      {open && done && (
        <div className="space-y-2 px-3 pb-3 pl-[38px]">
          {args && (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Arguments</div>
              <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-subtle-foreground">{prettyJson(step.arguments)}</pre>
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Result preview</div>
            <pre className="scrollbar-thin max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-subtle-foreground">{preview || 'No result preview.'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function StepTimer({ since }: { since: number }) {
  const now = useNow(100);
  return <>{((now - since) / 1000).toFixed(1)} s</>;
}

function Composer({ inputRef, value, onChange, onSend, onStop, running, blocked, disabled, status }: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void; onSend: () => void; onStop: () => void;
  running: boolean; blocked: boolean; disabled: boolean; status: string;
}) {
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value, inputRef]);
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!running && !blocked && value.trim()) onSend();
    }
  }
  const canSend = !running && !blocked && !disabled && !!value.trim();
  return (
    <div className="shrink-0 px-4 pb-4 pt-2 md:px-7 md:pb-5">
      <div className="mx-auto w-full max-w-[704px]">
        <div className={cn('rounded-[14px] border bg-card px-3.5 pb-2 pt-2.5 shadow-xs transition-[box-shadow,border-color] focus-within:border-border-strong focus-within:ring-[3px] focus-within:ring-ring/12', disabled && 'opacity-60')}>
          <label htmlFor="chat-input" className="sr-only">Message</label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={running ? 'You can type the next message while this runs…' : 'Ask about orders, rates, notes…'}
            className="block max-h-[200px] min-h-[44px] w-full resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 pt-1">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{blocked ? 'Another conversation is still running.' : status}</span>
            {running ? (
              <Button type="button" variant="outline" size="sm" onClick={onStop} aria-label="Stop generating">
                <span className="size-2.5 rounded-[2px] bg-foreground" aria-hidden="true" />Stop
              </Button>
            ) : (
              <Hint label="Send (Enter)">
                <Button type="button" size="icon-sm" onClick={onSend} disabled={!canSend} aria-label="Send message" className="rounded-lg">
                  <ArrowUp className="size-4" />
                </Button>
              </Hint>
            )}
          </div>
        </div>
        <p className="mt-2 hidden text-center text-[11.5px] text-muted-foreground sm:block">Enter to send · Shift + Enter for a new line · tool calls are recorded in the audit log</p>
      </div>
    </div>
  );
}
