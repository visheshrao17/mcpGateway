import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { env, json, serveMcp, toolError } from '@urumi/mcp-kit';

type Note = { id: string; title: string; body: string; created_at: string };

export function createNoteStore(file: string) {
  let notes: Note[] = [];
  try {
    notes = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(notes));
    renameSync(`${file}.tmp`, file);
  };
  return {
    add(title: string, body: string): Note {
      const note = { id: randomUUID(), title, body, created_at: new Date().toISOString() };
      notes.push(note);
      save();
      return note;
    },
    list: (limit: number) => notes.slice(-limit).reverse(),
    get: (id: string) => notes.find((n) => n.id === id),
  };
}

export function registerNoteTools(server: import('@modelcontextprotocol/server').McpServer, store: ReturnType<typeof createNoteStore>) {
  server.registerTool(
    'create_note',
    {
      description: 'Save a note visible to the whole team.',
      inputSchema: z.object({ title: z.string().min(1).max(200), body: z.string().max(20_000) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ title, body }) => json(store.add(title, body)),
  );

  server.registerTool(
    'list_notes',
    {
      description: 'List the most recent team notes, newest first (title and id only).',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: { readOnlyHint: true },
    },
    ({ limit }) => json({ notes: store.list(limit).map(({ id, title, created_at }) => ({ id, title, created_at })) }),
  );

  server.registerTool(
    'get_note',
    {
      description: 'Read one note by id.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const note = store.get(id);
      return note ? json(note) : toolError(`note ${id} not found`);
    },
  );
}

if (import.meta.main) {
  const store = createNoteStore(env('NOTES_FILE', '/data/notes.json'));
  serveMcp({ name: 'notes', version: '1.0.0', register: (server) => registerNoteTools(server, store) });
}
