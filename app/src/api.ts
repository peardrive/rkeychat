/**
 * Typed client for every route in docs/projects-api.md. With VITE_MOCK=1 the same interface is
 * served from an in-memory fixture (mock/), so the app runs without a daemon.
 */
import type { AgentInfo, Charter, DebugNoteInfo, DebugSpaceInfo, Conversation, Device, FileEntry, LogPage, LoginAsk, PendingProject, PendingRequest, Person, Rec, RoomSummary, SearchHit, Seat, StateResponse } from './types';

export interface Api {
  state(room?: string | null, conv?: string | null): Promise<StateResponse>;
  rooms(): Promise<RoomSummary[]>;
  log(q: { room: string; conv?: string; limit?: number; before?: string; after?: string; around?: string }): Promise<LogPage>;
  convs(room: string): Promise<Conversation[]>;
  createConv(body: { room: string; title: string; runtime?: string | null; text?: string }): Promise<Conversation>;
  renameConv(body: { room: string; conv: string; title: string }): Promise<Conversation>;
  archiveConv(body: { room: string; conv: string; archived: boolean }): Promise<Conversation>;
  setConvRuntime(body: { room: string; conv: string; runtime: string | null }): Promise<Conversation>;
  send(body: { room: string; as: string; text: string; conv: string; re?: string[] }): Promise<Rec>;
  search(q: { q: string; room?: string; conv?: string; limit?: number }): Promise<{ results: SearchHit[] }>;
  activity(q: { room: string; conv?: string }): Promise<unknown>;
  /** `home` (a device ref or name) elsewhere → the daemon asks that device and answers `{ pending: true, … }`. */
  createProject(body: { folder?: string; name?: string; home?: string; prompt?: string; org?: string; agent?: string; via?: 'acp' | 'cli' }): Promise<{ room: RoomSummary; seat: Seat | string } | PendingProject>;
  /** The projects this device asked other devices for that no room has answered yet (the "waiting on …" rows). */
  pendingProjects(): Promise<PendingRequest[]>;
  renameRoom(body: { room: string; name: string }): Promise<unknown>;
  setRoomOrg(body: { room: string; org: string | null }): Promise<RoomSummary>;
  /** Takes the room off this device; the folder on disk stays. */
  removeRoom(body: { room: string }): Promise<{ removed: boolean; topic: string; seats?: string[]; folder?: string | null }>;
  files(room: string): Promise<FileEntry[]>;
  fetchFile(body: { room: string; hash: string }): Promise<FileEntry & { path: string }>;
  invite(room: string): Promise<{ invite: string; room: string }>;
  people(): Promise<{ local: Person[]; known: Person[] }>;
  agents(): Promise<AgentInfo[]>;
  loginAsks(): Promise<{ asking: LoginAsk[] }>;
  loginGrant(topic: string): Promise<unknown>;
  loginDeny(topic: string): Promise<unknown>;
  debugNotes(): Promise<DebugSpaceInfo & { notes: DebugNoteInfo[] }>;
  /** `audio` is base64 of the recording (≤ 8 MB), or null for a steps-only note. */
  debugSaveNote(body: { id: string; audio: string | null; audioType: string | null; trace: unknown[]; meta: Record<string, unknown> }): Promise<{ id: string; dir?: string; files?: string[]; shared?: boolean; sharelink?: string | null }>;
  /** Posts a saved note's files into a room's conversation. */
  debugShare(body: { id: string; room: string }): Promise<unknown>;
  devices(): Promise<Device[]>;
  workspace(): Promise<{ workspace: string }>;
  setWorkspace(body: { workspace: string }): Promise<{ workspace: string }>;
  bindFolder(body: { room: string; folder: string }): Promise<RoomSummary>;
  react(body: { room: string; as?: string; target: string; emoji: string; on?: boolean }): Promise<Rec>;
  charter(body: { room: string } & Charter): Promise<unknown>;
  setAgentVia(body: { name: string; via: 'acp' | 'cli' }): Promise<unknown>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const qs = (q: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    throw new ApiError(res.status, err || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

const get = <T>(path: string, q: Record<string, string | number | null | undefined> = {}) => request<T>('GET', `/api/${path}${qs(q)}`);
const post = <T>(path: string, body: unknown) => request<T>('POST', `/api/${path}`, body);

export const httpApi: Api = {
  state: (room, conv) => get('state', { room, conv }),
  rooms: () => get('rooms'),
  log: (q) => get('log', q),
  convs: (room) => get('convs', { room }),
  createConv: (b) => post('convs', b),
  renameConv: (b) => post('convs/rename', b),
  archiveConv: (b) => post('convs/archive', b),
  setConvRuntime: (b) => post('convs/runtime', b),
  send: (b) => post('send', b),
  search: (q) => get('search', q),
  activity: (q) => get('activity', q),
  createProject: (b) => post('projects', b),
  pendingProjects: () => get('projects/pending'),
  bindFolder: (b) => post('rooms/folder', b),
  devices: () => get('devices'),
  workspace: () => get('workspace'),
  setWorkspace: (b) => post('workspace', b),
  react: (b) => post('react', b),
  charter: ({ room, text, order, agents }) => post('control', { room, action: 'charter', text, order, agents }),
  renameRoom: ({ room, name }) => post('control', { room, action: 'rename', name }),
  setRoomOrg: (b) => post('rooms/org', b),
  removeRoom: (b) => post('rooms/remove', b),
  files: (room) => get('files', { room }),
  fetchFile: (b) => post('fetch', b),
  invite: (room) => get('invite', { room }),
  people: () => get('people'),
  agents: () => get('agents'),
  loginAsks: () => get('login/pending'),
  loginGrant: (topic) => post('login/grant', { topic }),
  loginDeny: (topic) => post('login/deny', { topic }),
  debugNotes: () => get('debug/notes'),
  debugSaveNote: (b) => post('debug/note', b),
  debugShare: (b) => post('debug/share', b),
  setAgentVia: (b) => post('agents/via', b),
};

export const MOCK = import.meta.env?.VITE_MOCK === '1';

let api: Api = httpApi;
/** Swap the implementation (the mock does this at startup; tests may too). */
export function setApi(next: Api) {
  api = next;
}
export function getApi(): Api {
  return api;
}
