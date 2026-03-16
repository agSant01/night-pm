/**
 * Shared MCP tool handlers used by both the Claude SDK server (mcp-tools.ts)
 * and the HTTP/SSE MCP server (mcp-http.ts). Single source of truth for tool logic.
 * Uses file paths only (no storage abstraction).
 */

import { randomUUID as uuidv4 } from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { readJsonFile, readTextFile, writeJsonFile } from './file-io';

/** Single return format for all tools; used by both mcp-http and mcp-tools. */
export type ToolResult = {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
};

export type ProjectPaths = {
  calFile: string;
  todoFile: string;
  contactFile: string;
  thoughtFile: string;
  infoFile: string;
  nipmFile: string;
  ideasFile: string;
  secretsFile: string;
  standupFile: string;
};

export type McpContext = {
  /** Active project path, or null if none selected. Tools that need project files are wrapped with requireProject() in the registry. */
  projectPath: string | null;
  paths: ProjectPaths;
  scanRoot: string;
  setActiveProject?: (projectPath: string) => void;
  scanProjectTree: (dir: string) => Promise<Record<string, unknown>[]>;
};

export type CreateMcpContextOptions = {
  projectPath: string | null;
  scanRoot: string;
  setActiveProject?: (projectPath: string) => void;
  scanProjectTree: (dir: string) => Promise<Record<string, unknown>[]>;
};

/** Single place to build McpContext. Used by both mcp-http (per request) and mcp-tools (per server). */
export function createMcpContext(opts: CreateMcpContextOptions): McpContext {
  const { projectPath, scanRoot, setActiveProject, scanProjectTree } = opts;
  const pp = projectPath?.trim() ?? null;
  return {
    projectPath: pp,
    paths: createProjectPaths(pp ?? '.'),
    scanRoot: scanRoot ?? '',
    setActiveProject,
    scanProjectTree,
  };
}

/** Wraps a handler so it only runs when a project is selected. Applied by default in HTTP transport unless tool has skipProjectCheck. */
export function requireProject<T>(
  handler: (ctx: McpContext, args: T) => Promise<ToolResult>,
): (ctx: McpContext, args: T) => Promise<ToolResult> {
  return async (ctx, args: T) => {
    if (!ctx.projectPath?.trim()) {
      return err('No project selected. Open or select a project in Night PM first.');
    }
    return handler(ctx, args);
  };
}

// ─── Handlers ─────────────────────────────────────────────────────


export function createProjectPaths(projectPath: string): ProjectPaths {
  const join = (f: string) => path.join(projectPath, f);
  return {
    calFile: join('calendar.json'),
    todoFile: join('todos.json'),
    contactFile: join('contacts.json'),
    thoughtFile: join('thoughts.json'),
    infoFile: join('info.md'),
    nipmFile: join('project.nipm'),
    ideasFile: join('ideas.json'),
    secretsFile: join('secrets.json'),
    standupFile: join('standup.json'),
  };
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export type McpTool = {
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (ctx: McpContext, args?: unknown) => Promise<ToolResult>;
  /** Set true to skip the default "project required" check (e.g. project_list, project_set_active). Default: project is required. */
  skipProjectCheck?: boolean;
};

// ─── Calendar handlers ────────────────────────────────────────────────────

export async function calendarListEvents(ctx: McpContext): Promise<ToolResult> {
  const events = await readJsonFile(ctx.paths.calFile);
  return ok(JSON.stringify(events, null, 2));
}

export async function calendarAddEvent(
  ctx: McpContext,
  args: {
    title: string;
    description?: string;
    start: string;
    end: string;
    allDay?: boolean;
    recurrence?: {
      frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
      interval?: number;
      endDate?: string;
    };
  },
): Promise<ToolResult> {
  const events = await readJsonFile(ctx.paths.calFile);
  const id = uuidv4();
  const event: Record<string, unknown> = {
    id,
    title: args.title,
    description: args.description ?? '',
    start: args.start,
    end: args.end,
    allDay: args.allDay ?? false,
    createdOn: new Date().toISOString(),
  };
  if (args.recurrence) event.recurrence = args.recurrence;
  events.push(event);
  await writeJsonFile(ctx.paths.calFile, events);
  return ok(`Event "${args.title}" added (ID: ${id})`);
}

export async function calendarUpdateEvent(
  ctx: McpContext,
  args: {
    id: string;
    title?: string;
    description?: string;
    start?: string;
    end?: string;
    allDay?: boolean;
    recurrence?: unknown;
  },
): Promise<ToolResult> {
  const events = await readJsonFile<Record<string, unknown>>(
    ctx.paths.calFile,
  );
  const idx = events.findIndex((e) => e.id === args.id);
  if (idx === -1) return err(`Event ${args.id} not found`);
  const clean = Object.fromEntries(
    Object.entries(args).filter(
      ([, v]) => v !== undefined && (v as string) !== 'id',
    ),
  );
  delete clean.id;
  events[idx] = { ...events[idx], ...clean };
  await writeJsonFile(ctx.paths.calFile, events);
  return ok('Event updated');
}

export async function calendarDeleteEvent(
  ctx: McpContext,
  args: { id: string },
): Promise<ToolResult> {
  const events = await readJsonFile<Record<string, unknown>>(
    ctx.paths.calFile,
  );
  const filtered = events.filter((e) => e.id !== args.id);
  if (filtered.length === events.length)
    return err(`Event ${args.id} not found`);
  await writeJsonFile(ctx.paths.calFile, filtered);
  return ok('Event deleted');
}

// ─── Todo handlers ─────────────────────────────────────────────────────────

export async function todoListTasks(
  ctx: McpContext,
  args: {
    status?: 'created' | 'blocked' | 'done';
    startDate?: string;
    endDate?: string;
  },
): Promise<ToolResult> {
  let todos = await readJsonFile<Record<string, unknown>>(
    ctx.paths.todoFile,
  );
  if (args.status) todos = todos.filter((t) => t.status === args.status);
  const { startDate, endDate } = args;
  if (startDate)
    todos = todos.filter(
      (t) => typeof t.dueDate === 'string' && t.dueDate >= startDate,
    );
  if (endDate)
    todos = todos.filter(
      (t) => typeof t.dueDate === 'string' && t.dueDate <= endDate,
    );
  return ok(JSON.stringify(todos, null, 2));
}

export async function todoAddTask(
  ctx: McpContext,
  args: {
    title: string;
    description?: string;
    dueDate?: string;
    status?: 'created' | 'blocked' | 'done';
  },
): Promise<ToolResult> {
  const todos = await readJsonFile(ctx.paths.todoFile);
  const now = new Date().toISOString();
  const id = uuidv4();
  todos.push({
    id,
    title: args.title,
    description: args.description ?? '',
    dueDate: args.dueDate ?? '',
    createdOn: now,
    updatedOn: now,
    status: args.status ?? 'created',
  });
  await writeJsonFile(ctx.paths.todoFile, todos);
  return ok(`Task "${args.title}" added (ID: ${id})`);
}

export async function todoUpdateTask(
  ctx: McpContext,
  args: {
    id: string;
    title?: string;
    description?: string;
    dueDate?: string;
    status?: 'created' | 'blocked' | 'done';
  },
): Promise<ToolResult> {
  const todos = await readJsonFile<Record<string, unknown>>(
    ctx.paths.todoFile,
  );
  const idx = todos.findIndex((t) => t.id === args.id);
  if (idx === -1) return err(`Task ${args.id} not found`);
  const clean = Object.fromEntries(
    Object.entries(args).filter(
      ([, v]) => v !== undefined && (v as string) !== 'id',
    ),
  );
  delete clean.id;
  todos[idx] = {
    ...todos[idx],
    ...clean,
    updatedOn: new Date().toISOString(),
  };
  await writeJsonFile(ctx.paths.todoFile, todos);
  return ok(`Task "${todos[idx].title}" updated`);
}

export async function todoDeleteTask(
  ctx: McpContext,
  args: { id: string },
): Promise<ToolResult> {
  const todos = await readJsonFile<Record<string, unknown>>(
    ctx.paths.todoFile,
  );
  const filtered = todos.filter((t) => t.id !== args.id);
  if (filtered.length === todos.length) return err(`Task ${args.id} not found`);
  await writeJsonFile(ctx.paths.todoFile, filtered);
  return ok('Task deleted');
}

// ─── Contact handlers ─────────────────────────────────────────────────────

export async function contactList(ctx: McpContext): Promise<ToolResult> {
  const contacts = await readJsonFile(ctx.paths.contactFile);
  return ok(JSON.stringify(contacts, null, 2));
}

export async function contactSearch(
  ctx: McpContext,
  args: { query: string },
): Promise<ToolResult> {
  const contacts = await readJsonFile<Record<string, unknown>>(
    ctx.paths.contactFile,
  );
  const q = args.query.toLowerCase().trim();
  const matches = contacts.filter((c) =>
    String(c.name ?? '')
      .toLowerCase()
      .includes(q),
  );
  if (matches.length === 0) return ok(`No contacts matching "${args.query}"`);
  return ok(
    `Found ${matches.length} contact(s):\n${JSON.stringify(matches, null, 2)}`,
  );
}

export async function contactAdd(
  ctx: McpContext,
  args: {
    name: string;
    title?: string;
    info?: string;
    relatedContacts?: { relatedContactId: string; relationship: string }[];
  },
): Promise<ToolResult> {
  const contacts = await readJsonFile<Record<string, unknown>>(
    ctx.paths.contactFile,
  );
  const existing = contacts.find(
    (c) =>
      String(c.name ?? '')
        .toLowerCase()
        .trim() === args.name.toLowerCase().trim(),
  );
  if (existing)
    return ok(
      `Contact "${existing.name}" already exists (ID: ${existing.id}). Use contact_update instead.`,
    );
  const id = uuidv4();
  contacts.push({
    id,
    name: args.name,
    title: args.title ?? '',
    info: args.info ?? '',
    relatedContacts: args.relatedContacts ?? [],
  });
  await writeJsonFile(ctx.paths.contactFile, contacts);
  return ok(`Contact "${args.name}" added (ID: ${id})`);
}

export async function contactUpdate(
  ctx: McpContext,
  args: {
    id: string;
    name?: string;
    title?: string;
    info?: string;
    relatedContacts?: { relatedContactId: string; relationship: string }[];
  },
): Promise<ToolResult> {
  const contacts = await readJsonFile<Record<string, unknown>>(
    ctx.paths.contactFile,
  );
  const idx = contacts.findIndex((c) => c.id === args.id);
  if (idx === -1) return err(`Contact ${args.id} not found`);
  const clean = Object.fromEntries(
    Object.entries(args).filter(
      ([, v]) => v !== undefined && (v as string) !== 'id',
    ),
  );
  delete clean.id;
  if (args.info !== undefined)
    (clean as Record<string, unknown>).info = contacts[idx].info
      ? `${contacts[idx].info}\n${args.info}`
      : args.info;
  contacts[idx] = { ...contacts[idx], ...clean };
  await writeJsonFile(ctx.paths.contactFile, contacts);
  return ok(`Contact "${contacts[idx].name}" updated`);
}

export async function contactDelete(
  ctx: McpContext,
  args: { id: string },
): Promise<ToolResult> {
  const contacts = await readJsonFile<Record<string, unknown>>(
    ctx.paths.contactFile,
  );
  const filtered = contacts.filter((c) => c.id !== args.id);
  if (filtered.length === contacts.length)
    return err(`Contact ${args.id} not found`);
  await writeJsonFile(ctx.paths.contactFile, filtered);
  return ok('Contact deleted');
}

// ─── Thought handlers ─────────────────────────────────────────────────────

export async function thoughtList(ctx: McpContext): Promise<ToolResult> {
  const thoughts = await readJsonFile(ctx.paths.thoughtFile);
  return ok(JSON.stringify(thoughts, null, 2));
}

export async function thoughtAdd(
  ctx: McpContext,
  args: { thought: string; actionsTriggered?: string[] },
): Promise<ToolResult> {
  const thoughts = await readJsonFile(ctx.paths.thoughtFile);
  thoughts.push({
    thought: args.thought,
    actionsTriggered: args.actionsTriggered ?? [],
    createdOn: new Date().toISOString(),
  });
  await writeJsonFile(ctx.paths.thoughtFile, thoughts);
  return ok('Thought recorded');
}

// ─── Project info handlers ────────────────────────────────────────────────

export async function projectInfo(ctx: McpContext): Promise<ToolResult> {
  const nipmContent = await readTextFile(ctx.paths.nipmFile);
  const mdContent = await readTextFile(ctx.paths.infoFile);
  const parts: string[] = [];
  if (nipmContent) parts.push(`project.nipm:\n${nipmContent}`);
  if (mdContent) parts.push(`info.md:\n${mdContent}`);
  return ok(parts.join('\n\n') || 'No project info available.');
}

export async function projectInfoUpdate(
  ctx: McpContext,
  args: {
    name?: string;
    description?: string;
    whoAmI?: string;
    tags?: string[];
  },
): Promise<ToolResult> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readTextFile(ctx.paths.nipmFile);
    if (raw.trim()) existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* create new */
  }
  if (args.name !== undefined) existing.name = args.name;
  if (args.description !== undefined) existing.description = args.description;
  if (args.whoAmI !== undefined) existing.whoAmI = args.whoAmI;
  if (args.tags !== undefined) existing.tags = args.tags;
  if (!existing.created) existing.created = new Date().toISOString();
  await fs.mkdir(path.dirname(ctx.paths.nipmFile), { recursive: true });
  await fs.writeFile(
    ctx.paths.nipmFile,
    JSON.stringify(existing, null, 2),
    'utf-8',
  );
  return ok('Project info updated');
}

// ─── Idea handlers ────────────────────────────────────────────────────────

export async function ideaList(ctx: McpContext): Promise<ToolResult> {
  const ideas = await readJsonFile(ctx.paths.ideasFile);
  return ok(JSON.stringify(ideas, null, 2));
}

export async function ideaAdd(
  ctx: McpContext,
  args: { title: string; description?: string; tags?: string[] },
): Promise<ToolResult> {
  const ideas = await readJsonFile(ctx.paths.ideasFile);
  const id = uuidv4();
  ideas.push({
    id,
    title: args.title,
    description: args.description ?? '',
    createdOn: new Date().toISOString(),
    tags: args.tags ?? [],
  });
  await writeJsonFile(ctx.paths.ideasFile, ideas);
  return ok(`Idea "${args.title}" added (ID: ${id})`);
}

export async function ideaUpdate(
  ctx: McpContext,
  args: {
    id: string;
    title?: string;
    description?: string;
    tags?: string[];
  },
): Promise<ToolResult> {
  const ideas = await readJsonFile<Record<string, unknown>>(
    ctx.paths.ideasFile,
  );
  const idx = ideas.findIndex((i) => i.id === args.id);
  if (idx === -1) return err(`Idea ${args.id} not found`);
  const clean = Object.fromEntries(
    Object.entries(args).filter(
      ([, v]) => v !== undefined && (v as string) !== 'id',
    ),
  );
  delete clean.id;
  ideas[idx] = { ...ideas[idx], ...clean };
  await writeJsonFile(ctx.paths.ideasFile, ideas);
  return ok('Idea updated');
}

export async function ideaDelete(
  ctx: McpContext,
  args: { id: string },
): Promise<ToolResult> {
  const ideas = await readJsonFile<Record<string, unknown>>(
    ctx.paths.ideasFile,
  );
  const filtered = ideas.filter((i) => i.id !== args.id);
  if (filtered.length === ideas.length) return err(`Idea ${args.id} not found`);
  await writeJsonFile(ctx.paths.ideasFile, filtered);
  return ok('Idea deleted');
}

// ─── Secret handlers ─────────────────────────────────────────────────────

export async function secretList(ctx: McpContext): Promise<ToolResult> {
  const secrets = await readJsonFile(ctx.paths.secretsFile);
  return ok(JSON.stringify(secrets, null, 2));
}

export async function secretAdd(
  ctx: McpContext,
  args: { text: string },
): Promise<ToolResult> {
  const secrets = await readJsonFile(ctx.paths.secretsFile);
  const id = uuidv4();
  secrets.push({ id, text: args.text, createdOn: new Date().toISOString() });
  await writeJsonFile(ctx.paths.secretsFile, secrets);
  const thoughts = await readJsonFile<Record<string, unknown>>(
    ctx.paths.thoughtFile,
  );
  const cleaned = thoughts.filter((t) => String(t.thought ?? '') !== args.text);
  if (cleaned.length !== thoughts.length)
    await writeJsonFile(ctx.paths.thoughtFile, cleaned);
  return ok(`Secret recorded (ID: ${id}). Removed from thought log.`);
}

// ─── Standup handlers ────────────────────────────────────────────────────

export async function standupList(ctx: McpContext): Promise<ToolResult> {
  const standups = await readJsonFile(ctx.paths.standupFile);
  return ok(JSON.stringify(standups, null, 2));
}

export async function standupGenerate(
  ctx: McpContext,
  args: { startDate?: string; endDate?: string },
): Promise<ToolResult> {
  const now = new Date();
  const end = args.endDate ? new Date(args.endDate) : now;
  const start = args.startDate
    ? new Date(args.startDate)
    : new Date(new Date(end).setDate(end.getDate() - 1));
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  const todos = await readJsonFile<Record<string, unknown>>(
    ctx.paths.todoFile,
  );
  const events = await readJsonFile<Record<string, unknown>>(
    ctx.paths.calFile,
  );

  const recentlyDone = todos.filter((t) => {
    if (t.status !== 'done') return false;
    const updated = String(t.updatedOn ?? '');
    return updated >= startStr && updated <= endStr + 'T23:59:59';
  });
  const inProgress = todos.filter((t) => t.status === 'created');
  const blocked = todos.filter((t) => t.status === 'blocked');
  const rangeEvents = events.filter((e) => {
    const eDate = String(e.start ?? '').split('T')[0];
    return eDate >= startStr && eDate <= endStr;
  });

  const doneItems = recentlyDone.map((t) => String(t.title));
  const ipItems = inProgress.map(
    (t) => `${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ''}`,
  );
  const blockedItems = blocked.map((t) => String(t.title));
  const eventItems = rangeEvents.map((e) => `${e.title} (${e.start})`);

  const rangeLabel = startStr === endStr ? endStr : `${startStr} → ${endStr}`;
  const sections = [
    `## Standup for ${rangeLabel}`,
    `### Done\n${doneItems.length ? doneItems.map((i) => `- ${i}`).join('\n') : '- (none)'}`,
    `### In Progress\n${ipItems.length ? ipItems.map((i) => `- ${i}`).join('\n') : '- (none)'}`,
    `### Blocked\n${blockedItems.length ? blockedItems.map((i) => `- ${i}`).join('\n') : '- (none)'}`,
    `### Events\n${eventItems.length ? eventItems.map((i) => `- ${i}`).join('\n') : '- (none)'}`,
  ];
  const summary = sections.join('\n\n');

  const standups = await readJsonFile<Record<string, unknown>>(
    ctx.paths.standupFile,
  );
  const existingIdx = standups.findIndex((s) => s.date === endStr);
  const entry = {
    id: existingIdx >= 0 ? (standups[existingIdx].id as string) : uuidv4(),
    date: endStr,
    startDate: startStr,
    endDate: endStr,
    summary,
    done: doneItems,
    inProgress: ipItems,
    blocked: blockedItems,
    events: eventItems,
    createdOn:
      existingIdx >= 0
        ? (standups[existingIdx].createdOn as string)
        : new Date().toISOString(),
  };
  if (existingIdx >= 0) standups[existingIdx] = entry;
  else standups.push(entry);
  await writeJsonFile(ctx.paths.standupFile, standups);
  return ok(summary);
}

export async function standupDelete(
  ctx: McpContext,
  args: { id: string },
): Promise<ToolResult> {
  const standups = await readJsonFile<Record<string, unknown>>(
    ctx.paths.standupFile,
  );
  const filtered = standups.filter((s) => s.id !== args.id);
  if (filtered.length === standups.length)
    return err(`Standup ${args.id} not found`);
  await writeJsonFile(ctx.paths.standupFile, filtered);
  return ok('Standup deleted');
}

// ─── Project discovery handlers ───────────────────────────────────────────

export async function projectList(ctx: McpContext): Promise<ToolResult> {
  if (!ctx.scanRoot.trim()) return err('No root path configured');
  const tree = await ctx.scanProjectTree(ctx.scanRoot);
  return ok(JSON.stringify(tree, null, 2));
}

export async function projectSetActive(
  ctx: McpContext,
  args: { path: string },
): Promise<ToolResult> {
  if (ctx.setActiveProject) {
    ctx.setActiveProject(args.path);
    return ok(`Active project set to "${args.path}"`);
  }
  return err('Cannot change active project in this context');
}

// ─── Tool registry: schema + handler (mcp-tools-style: most complete) ─────
// Schemas match mcp-tools.ts: .describe() on params + richer tool descriptions.

const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().optional().describe('Repeat every N frequency units'),
    endDate: z.string().optional().describe('Recurrence end date ISO'),
  })
  .optional()
  .describe('Recurrence rule');

const relatedContactSchema = z.object({
  relatedContactId: z.string(),
  relationship: z.string(),
});

const toolsImpl = {
  calendar_list_events: {
    description: 'List all calendar events',
    schema: {},
    handler: requireProject(calendarListEvents),
  },
  calendar_add_event: {
    description: 'Add a new calendar event',
    schema: {
      title: z.string().describe('Event title'),
      description: z.string().optional().default('').describe('Event description'),
      start: z.string().describe('Start date/time ISO string'),
      end: z.string().describe('End date/time ISO string'),
      allDay: z.boolean().optional().default(false).describe('All-day event'),
      recurrence: recurrenceSchema,
    },
    handler: requireProject(calendarAddEvent),
  },
  calendar_update_event: {
    description: 'Update an existing calendar event',
    schema: {
      id: z.string().describe('Event ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      start: z.string().optional().describe('New start'),
      end: z.string().optional().describe('New end'),
      allDay: z.boolean().optional().describe('New all-day flag'),
      recurrence: recurrenceSchema,
    },
    handler: requireProject(calendarUpdateEvent),
  },
  calendar_delete_event: {
    description: 'Delete a calendar event',
    schema: { id: z.string().describe('Event ID') },
    handler: requireProject(calendarDeleteEvent),
  },
  todo_list_tasks: {
    description: 'List tasks, optionally filter by status and/or date range',
    schema:   {
      status: z.enum(['created', 'blocked', 'done']).optional().describe('Filter by status'),
      startDate: z.string().optional().describe('Only tasks with dueDate >= this ISO date (inclusive)'),
      endDate: z.string().optional().describe('Only tasks with dueDate <= this ISO date (inclusive)'),
    },
    handler: requireProject(todoListTasks),
  },
  todo_add_task: {
    description: 'Add a new task',
    schema: {
      title: z.string().describe('Task title'),
      description: z.string().optional().default('').describe('Description'),
      dueDate: z.string().optional().default('').describe('Due date ISO'),
      status: z.enum(['created', 'blocked', 'done']).optional().default('created').describe('Status'),
    },
    handler: requireProject(todoAddTask),
  },
  todo_update_task: {
    description: 'Update an existing task',
    schema: {
      id: z.string().describe('Task ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      dueDate: z.string().optional().describe('New due date'),
      status: z.enum(['created', 'blocked', 'done']).optional().describe('New status'),
    },
    handler: requireProject(todoUpdateTask),
  },
  todo_delete_task: {
    description: 'Delete a task',
    schema: { id: z.string().describe('Task ID') },
    handler: requireProject(todoDeleteTask),
  },
  contact_list: {
    description: 'List all contacts',
    schema: {},
    handler: requireProject(contactList),
  },
  contact_search: {
    description: 'Search contacts by name (partial, case-insensitive). Use BEFORE contact_add to check duplicates.',
    schema: { query: z.string().describe('Search query') },
    handler: requireProject(contactSearch),
  },
  contact_add: {
    description: 'Add a new contact. Checks for duplicates by name first.',
    schema: {
      name: z.string().describe('Contact name'),
      title: z.string().optional().default('').describe('Title/role'),
      info: z.string().optional().default('').describe('Additional info'),
      relatedContacts: z.array(relatedContactSchema).optional().default([]).describe('Related contacts'),
    },
    handler: requireProject(contactAdd),
  },
  contact_update: {
    description: 'Update an existing contact',
    schema: {
      id: z.string().describe('Contact ID'),
      name: z.string().optional().describe('New name'),
      title: z.string().optional().describe('New title'),
      info: z.string().optional().describe('New info (appended)'),
      relatedContacts: z.array(relatedContactSchema).optional().describe('Related contacts'),
    },
    handler: requireProject(contactUpdate),
  },
  contact_delete: {
    description: 'Delete a contact',
    schema: { id: z.string().describe('Contact ID') },
    handler: requireProject(contactDelete),
  },
  thought_list: {
    description: 'List all recorded thoughts',
    schema: {},
    handler: requireProject(thoughtList),
  },
  thought_add: {
    description: 'Add a new thought entry',
    schema: {
      thought: z.string().describe('The thought text'),
      actionsTriggered: z.array(z.string()).optional().default([]).describe('Actions triggered'),
    },
    handler: requireProject(thoughtAdd),
  },
  project_info: {
    description: 'Read the project info/context from project.nipm and info.md',
    schema: {},
    handler: requireProject(projectInfo),
  },
  project_info_update: {
    description: 'Update the project identity file (project.nipm)',
    schema: {
      name: z.string().optional().describe('Project name'),
      description: z.string().optional().describe('Project description'),
      whoAmI: z.string().optional().describe('Who am I in this project context'),
      tags: z.array(z.string()).optional().describe('Project tags'),
    },
    handler: requireProject(projectInfoUpdate),
  },
  idea_list: {
    description: 'List all ideas',
    schema: {},
    handler: requireProject(ideaList),
  },
  idea_add: {
    description: 'Add a new half-baked idea',
    schema: {
      title: z.string().describe('Idea title'),
      description: z.string().optional().default('').describe('Description'),
      tags: z.array(z.string()).optional().default([]).describe('Tags'),
    },
    handler: requireProject(ideaAdd),
  },
  idea_update: {
    description: 'Update an existing idea',
    schema: {
      id: z.string().describe('Idea ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      tags: z.array(z.string()).optional().describe('New tags'),
    },
    handler: requireProject(ideaUpdate),
  },
  idea_delete: {
    description: 'Delete an idea',
    schema: { id: z.string().describe('Idea ID') },
    handler: requireProject(ideaDelete),
  },
  secret_list: {
    description: 'List all secrets (private thoughts)',
    schema: {},
    handler: requireProject(secretList),
  },
  secret_add: {
    description: 'Add a private secret thought (never used for document generation). Automatically removes the matching entry from thoughts.json.',
    schema: { text: z.string().describe('The secret text') },
    handler: requireProject(secretAdd),
  },
  standup_list: {
    description: 'List all saved standups',
    schema: {},
    handler: requireProject(standupList),
  },
  standup_generate: {
    description: 'Generate and save a standup update. ALWAYS call this when the user asks for a standup, daily update, status report, or daily summary.',
    schema: {
      startDate: z.string().optional().describe('Start of date range for tasks/events to consider (ISO date, inclusive). Defaults to yesterday.'),
      endDate: z.string().optional().describe('End of date range for tasks/events to consider (ISO date, inclusive). Defaults to today.'),
    },
    handler: requireProject(standupGenerate),
  },
  standup_delete: {
    description: 'Delete a standup entry',
    schema: { id: z.string().describe('Standup ID to delete') },
    handler: requireProject(standupDelete),
  },
  project_list: {
    description: 'List all available projects (recursive tree with nested projects)',
    schema: {},
    handler: projectList,
    skipProjectCheck: true,
  },
  project_set_active: {
    description: 'Set the active project by path',
    schema: { path: z.string().describe('Absolute path to the project folder') },
    handler: projectSetActive,
    skipProjectCheck: true,
  },
} as const;

export const tools = toolsImpl as unknown as Record<string, McpTool>;
