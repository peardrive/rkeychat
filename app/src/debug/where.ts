/**
 * What a debug note is stamped with: where the app is (`where`) and what a click hit (`describe`).
 * Pure functions, so they can be tested without a DOM or the store.
 */
export type DebugPage = 'home' | 'activity' | 'projects' | 'conversation' | 'files' | 'project' | 'profile' | 'settings';

export interface WhereInput {
  page: DebugPage;
  org?: string | null;
  project?: string | null;
  conversation?: string | null;
}

export interface Where {
  page: DebugPage;
  org?: string;
  project?: string;
  conversation?: string;
}

/** `{ org, project, conversation, page }`, with only the parts that apply. */
export function whereFrom(input: WhereInput): Where {
  const out: Where = { page: input.page };
  if (input.org) out.org = input.org;
  if (input.project) out.project = input.project;
  if (input.conversation && !['home', 'activity', 'projects', 'settings'].includes(input.page)) out.conversation = input.conversation;
  return out;
}

/** The little of a DOM element `describe` reads, so tests can pass plain objects. */
export interface ElementLike {
  closest?: (selector: string) => ElementLike | null;
  getAttribute?: (name: string) => string | null;
}

const attr = (el: ElementLike | null | undefined, name: string) => el?.getAttribute?.(name) ?? null;

/**
 * Names the rows this app owns: a project row → `project <name>`, a conversation row → `conversation <title>`,
 * a message → `message by <name>`. Anything else is left to pearkit's default description.
 */
export function describeFrom(target: ElementLike, hit: ElementLike): { text: string; data?: Record<string, unknown> } | null {
  const find = (sel: string) => target.closest?.(sel) ?? hit.closest?.(sel) ?? null;
  const conv = find('[data-conversation]');
  if (conv) return { text: `conversation ${attr(conv, 'data-conversation')}`, data: { project: attr(conv, 'data-project') ?? undefined } };
  const project = find('[data-project]');
  if (project) return { text: `project ${attr(project, 'data-project')}` };
  const msg = find('[aria-label$=". Actions"]');
  if (msg) {
    const label = attr(msg, 'aria-label') ?? '';
    const name = label.split(':')[0]?.trim();
    if (name) return { text: `message by ${name}` };
  }
  return null;
}
