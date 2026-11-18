/**
 * Shapes from docs/projects-api.md plus the record fields the daemon already emits (src/room.js view()).
 * The contract is fixed; anything not in the document is typed loosely and read defensively.
 */

export type Conversation = {
  conv: string; // 'main' for the default
  title: string; // 'General' for main unless renamed
  created: number; // ms
  archived: boolean;
  runtime: string | null;
  last: { ts: number; name: string; text: string } | null;
  count: number;
  busy: string[]; // seat names with a turn in flight here
};

export type ConvSummary = Pick<Conversation, 'conv' | 'title' | 'archived' | 'last' | 'count'>;

export type AppRecord = { app: 'rkeychat'; role: 'project' | 'chat'; name: string; icon?: string } | null;

export type Seat = { name: string; bridge: 'claude' | 'hermes' | 'stream'; via: 'acp' | 'cli' | null; dir: string | null };

export type ProjectInfo = { folder: string | null; app: AppRecord; seats: Seat[] };

export type RoomSummary = {
  name: string;
  topic: string;
  owner: boolean;
  admitted: boolean;
  folder: string | null;
  app: AppRecord;
  convs: ConvSummary[];
  unread?: number;
};

export type Attachment = {
  hash: string;
  kind?: 'file';
  name?: string;
  path?: string;
  mime?: string;
  size?: number;
  ms?: number;
  peaks?: number[];
};

/** A record as the daemon's view() hands it to the page (msg, activity, control…). */
export type Rec = {
  id: string;
  kind: 'msg' | 'activity' | 'control' | 'react' | 'redact' | 'invite' | string;
  ts: number;
  name: string; // display name of the author
  author?: string; // key ref
  device?: string;
  human?: boolean;
  text: string;
  re?: string[];
  conv?: string;
  att?: Attachment[];
  via?: string;
  redacted?: { by: string; ts: number };
  action?: string;
  mentions?: string[];
  /** Local only: an optimistic send that the daemon has not confirmed yet. */
  pending?: boolean;
};

export type Participant = {
  name: string;
  role: 'human' | 'agent';
  ref?: string;
  status?: string;
  local?: boolean;
  online?: boolean;
  state?: string;
  busy?: boolean;
  devices?: string[];
};

export type Member = { name: string; device?: string; ref?: string; scope?: string[]; status?: string; depth?: number };

export type Charter = { text: string; order: string[]; agents: Record<string, unknown> };

/** Reactions as the daemon keeps them: { msgId: { emoji: [names] } }. */
export type Reactions = Record<string, Record<string, string[]>>;

export type RoomSnapshot = {
  name: string;
  topic: string;
  owner: boolean;
  root?: string | null;
  admitted: boolean;
  participants: Participant[];
  members: Member[];
  reactions: Reactions;
  charter: Charter;
  style?: unknown;
  budget?: unknown;
  spend?: unknown;
  connections?: unknown;
  log: Rec[];
  hasOlder: boolean;
  // projects branch
  convs: Conversation[];
  folder: string | null;
  app: AppRecord;
  seats: Seat[];
};

export type DeviceInfo = {
  name: string;
  ref: string;
  root: string | null;
  participants: { name: string; role: 'human' | 'agent'; ref: string; bridge?: string }[];
  /** True when the daemon runs inside the desktop app (window.rkc is the folder picker then). */
  desktop?: boolean;
};

export type StateResponse = {
  device: DeviceInfo;
  rooms: RoomSummary[];
  canTranscribe?: boolean;
  current: RoomSnapshot | null;
};

export type LogPage = { log: Rec[]; hasOlder: boolean; hasNewer?: boolean };

export type SearchHit = { id: string; ts: number; name: string; snippet: string; topic?: string; room?: string; conv?: string };

export type AgentState = 'idle' | 'thinking' | 'waiting' | 'error' | 'offline';

/* ───────────── push events (SSE) ───────────── */

export type Events = {
  record: { topic: string; rec: Rec; budget?: unknown };
  convs: { topic: string; convs: Conversation[] };
  room: RoomSnapshot;
  rooms: RoomSummary[];
  participants: { topic: string; participants: Participant[] };
  activity: { topic: string; rec: Rec };
  /** The whole room's reactions map after a react record (the daemon does not re-push `room` for it). */
  reactions: { topic: string; reactions: Reactions };
  'agent-state': { topic: string; name: string; conv: string; state: AgentState };
  'agent-error': { topic: string; name: string; conv?: string; error: string };
};

export type EventName = keyof Events;
