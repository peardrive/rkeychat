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

/** The signed app note; `home` is the device whose disk holds the folder (projects-home-and-sync.md §1). */
export type AppRecord = {
  app: 'rkeychat';
  role: 'project' | 'chat';
  name: string;
  icon?: string;
  home?: { device: string; name: string } | null;
  /** The organization the project belongs to (round 2): a grouping name signed by the owner. */
  org?: string | null;
  /** The `project` request (its record id) this room answers, when another device asked for it. */
  request?: string | null;
} | null;

/** A file shared in a room (`GET /api/files?room=`). `local`: the bytes are on this device. */
export type FileEntry = { hash: string; kind?: 'file'; name: string; path?: string; mime?: string; size?: number; by: string; ts: number; local: boolean; providers: number };

/** `GET /api/people`: agents on this device and the people known from owned rooms. */
export type Person = { name: string; role: 'human' | 'agent'; local?: boolean; from?: string };

/** `GET /api/agents`: a seat hosted on this device. */
export type AgentInfo = {
  name: string;
  bridge: 'claude' | 'hermes' | 'stream';
  via: 'acp' | 'cli' | null;
  dir: string | null;
  ref?: string;
  rooms: { name: string; topic: string; enrolled: boolean; state: AgentState; busy: boolean }[];
};

/** A device asking to log in or join (`login-ask` push); answered with /api/login/grant|deny. */
export type LoginAsk = { topic: string; device: string; deviceName: string; names: { name: string; role: string }[]; room?: string | null; action: 'room' | 'login'; at: number; expires?: number };

/** A saved debug note (`GET /api/debug/notes` → notes[]): note.json plus where it is. */
export type DebugNoteInfo = { id: string; startedAt?: string; seconds?: number; steps?: number; app?: string; where?: Record<string, unknown>; noAudio?: string; audio?: string | null; dir?: string; from?: string };
export type DebugSpaceInfo = { dir: string; sharelink: string | null; topic?: string | null; count: number; error?: string };

/** An agent's rule in a room's charter. */
export type AgentRule = { role?: string; wake?: 'order' | 'mention' | 'backup'; backupFor?: string | null; tokensPerDay?: number };

/** One of the owner's own devices (`GET /api/devices`); this one first, with `here: true`. */
export type Device = { ref: string; name: string; online: boolean; here: boolean; /** On the `here` entry: can this device hold a project folder (false on a phone). */ canHost?: boolean };

/** `POST /api/projects` when another device is asked to create the project. */
export type PendingProject = { pending: true; asked: string; via: string; id: string; online: boolean };

/** `GET /api/projects/pending`: a project this device asked another device for, not yet seen to arrive. */
export type PendingRequest = { id: string; name: string; asked: string; home: string | null; via: string; ts: number; online: boolean };

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

export type Charter = { text: string; order: string[]; agents: Record<string, AgentRule> };

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
  /** False on a phone: projects must be homed on one of the owner's computers. */
  canHost?: boolean;
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
  'login-ask': LoginAsk;
  'agent-state': { topic: string; name: string; conv: string; state: AgentState };
  'agent-error': { topic: string; name: string; conv?: string; error: string };
};

export type EventName = keyof Events;
