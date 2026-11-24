/**
 * The store: one reducer, one context, and the actions that talk to the daemon. Pushes from
 * /api/events are dispatched straight into the reducer.
 */
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { getApi } from '../api';
import { connectEvents } from '../events';
import type { AgentRule, AutoLimit, Conversation, Device, PendingProject, RoomSummary, SeatChange } from '../types';
import { convKey, initialState, reducer, type Action, type State } from './reducer';
import type { Seat } from '../types';

const SELECTED_KEY = 'rkc.app.selected';
const HIDDEN_PENDING_KEY = 'rkc.app.pending-hidden';
const PAGE = 60;

function readHiddenPending(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_PENDING_KEY) ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function hidePending(id: string) {
  try {
    localStorage.setItem(HIDDEN_PENDING_KEY, JSON.stringify([...new Set([...readHiddenPending(), id])].slice(-50)));
  } catch {}
}

export interface Actions {
  /** Re-fetch everything; resolves with the room list (the reducer's state may not have rendered yet). */
  reload(): Promise<RoomSummary[]>;
  select(topic: string | null, conv: string | null): Promise<void>;
  loadOlder(topic: string, conv: string): Promise<void>;
  send(topic: string, conv: string, text: string, re?: string[]): Promise<void>;
  createConversation(topic: string, title?: string, text?: string): Promise<Conversation>;
  renameConversation(topic: string, conv: string, title: string): Promise<void>;
  archiveConversation(topic: string, conv: string, archived: boolean): Promise<void>;
  setRuntime(topic: string, conv: string, runtime: string | null): Promise<void>;
  /** Returns the new room and the name of its project seat. */
  createProject(opts: { folder?: string; name?: string; home?: string; prompt?: string; org?: string }): Promise<{ room: RoomSummary; seat: string } | PendingProject>;
  renameRoom(topic: string, name: string): Promise<void>;
  setRoomOrg(topic: string, org: string | null): Promise<void>;
  removeRoom(topic: string): Promise<void>;
  /** Change one agent's rule in a room's charter (role, wake, backupFor, tokensPerDay), keeping the rest. */
  saveAgentRule(topic: string, name: string, rule: AgentRule): Promise<void>;
  loginGrant(topic: string): Promise<void>;
  loginDeny(topic: string): Promise<void>;
  /** Answer an agent's ask (allow_once | allow_always | reject_once | reject_always); only the owner's devices can. */
  answerAsk(topic: string, ask: string, choice: string): Promise<void>;
  /** Open a feed item: mark it read and go to its conversation. */
  openFeedItem(id: string): Promise<void>;
  loadDevices(): Promise<Device[]>;
  /** The projects this device asked other devices for and still waits on (the daemon's list). */
  loadPending(): Promise<void>;
  /** Stop showing a wait (the request stays in the room; a later answer still opens the project). */
  dismissPending(id: string): void;
  bindFolder(topic: string, folder: string): Promise<void>;
  saveCharter(topic: string, text: string): Promise<void>;
  setSeatVia(name: string, via: 'acp' | 'cli'): Promise<void>;
  /**
   * The bot's settings from its profile (permission mode, never bypass; model and provider; how long an ask waits):
   * a signed `seat` control the seat's host applies, from any of the owner's devices.
   */
  setSeat(topic: string, name: string, change: SeatChange): Promise<void>;
  /** The room's cap on Auto grants; the snapshot that follows carries it. */
  setAutoCap(topic: string, auto: AutoLimit): Promise<void>;
  setRounds(topic: string, change: { action: 'rounds' | 'extend' | 'until' | 'unlimited' | 'reset'; n?: number; hours?: number }): Promise<void>;
  setAgentLimit(topic: string, agent: string, n: number): Promise<void>;
  react(topic: string, target: string, emoji: string, on: boolean): Promise<void>;
  /** Re-fetch the first-run setup (after a provider or login changed). */
  refreshSetup(): Promise<void>;
  /** Save a setup choice; the daemon answers with the whole setup, which lands in the store. */
  saveSetup(patch: { agent?: string | null; done?: boolean }): Promise<void>;
}

const StoreContext = createContext<{ state: State; dispatch: React.Dispatch<Action>; actions: Actions } | null>(null);

function readSelected(): { topic: string; conv: string } | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo<Actions>(() => {
    const api = () => getApi();

    const openThread = async (topic: string, conv: string) => {
      const res = await api().state(topic, conv);
      if (res.current) dispatch({ type: 'room', snapshot: res.current, conv });
    };

    const a: Actions = {
      async reload() {
        try {
          const sel = stateRef.current.selected;
          const res = await api().state(sel.topic, sel.conv);
          const human = res.device.participants.find((p) => p.role === 'human')?.name ?? null;
          dispatch({ type: 'init', device: { name: res.device.name, ref: res.device.ref, human, canHost: res.device.canHost }, rooms: res.rooms, current: null });
          if (res.current && sel.conv) dispatch({ type: 'room', snapshot: res.current, conv: sel.conv });
          else if (res.current) dispatch({ type: 'room', snapshot: res.current });
          return res.rooms;
        } catch (e) {
          dispatch({ type: 'error', error: (e as Error).message });
          return [];
        }
      },
      async select(topic, conv) {
        dispatch({ type: 'select', topic, conv });
        try {
          if (topic && conv) localStorage.setItem(SELECTED_KEY, JSON.stringify({ topic, conv }));
        } catch {}
        if (!topic || !conv) return;
        const s = stateRef.current;
        const thread = s.threads[convKey(topic, conv)];
        if (!s.details[topic] || !thread?.loaded) await openThread(topic, conv);
      },
      async loadOlder(topic, conv) {
        const key = convKey(topic, conv);
        const thread = stateRef.current.threads[key];
        if (!thread || !thread.hasOlder || thread.loadingOlder) return;
        const first = thread.items.find((x) => !x.pending);
        if (!first) return;
        dispatch({ type: 'loadingOlder', topic, conv, value: true });
        try {
          const page = await api().log({ room: topic, conv, before: first.id, limit: PAGE });
          dispatch({ type: 'log', topic, conv, log: page.log, hasOlder: page.hasOlder, mode: 'older' });
        } catch (e) {
          dispatch({ type: 'loadingOlder', topic, conv, value: false });
          throw e;
        }
      },
      async send(topic, conv, text, re) {
        const me = stateRef.current.me?.human;
        if (!me) throw new Error('No human on this device to post as.');
        const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        dispatch({ type: 'sendPending', topic, conv, rec: { id: localId, kind: 'msg', ts: Date.now(), name: me, human: true, text, re: re ?? [], conv } });
        try {
          const rec = await api().send({ room: topic, as: me, text, conv, re });
          dispatch({ type: 'sendDone', topic, conv, localId, rec });
        } catch (e) {
          dispatch({ type: 'sendFailed', topic, conv, localId });
          throw e;
        }
      },
      async createConversation(topic, title = 'New conversation', text) {
        const c = await api().createConv({ room: topic, title, text });
        dispatch({ type: 'conv', topic, conv: c });
        dispatch({ type: 'log', topic, conv: c.conv, log: [], hasOlder: false, mode: 'replace' });
        await a.select(topic, c.conv);
        return c;
      },
      async renameConversation(topic, conv, title) {
        const c = await api().renameConv({ room: topic, conv, title });
        dispatch({ type: 'conv', topic, conv: c });
      },
      async archiveConversation(topic, conv, archived) {
        const c = await api().archiveConv({ room: topic, conv, archived });
        dispatch({ type: 'conv', topic, conv: c });
      },
      async setRuntime(topic, conv, runtime) {
        const c = await api().setConvRuntime({ room: topic, conv, runtime });
        dispatch({ type: 'conv', topic, conv: c });
      },
      async loadDevices() {
        const devices = await api().devices();
        dispatch({ type: 'devices', devices });
        return devices;
      },
      async loadPending() {
        const list = await api().pendingProjects();
        dispatch({ type: 'pendingProjects', list, hidden: readHiddenPending() });
      },
      dismissPending(id) {
        hidePending(id);
        dispatch({ type: 'pendingDone', id });
      },
      async createProject(opts) {
        const res = await api().createProject(opts);
        if ('pending' in res && res.pending) {
          dispatch({ type: 'pendingProject', id: res.id, name: opts.name ?? '', asked: res.asked, online: res.online });
          return res;
        }
        const { room, seat } = res as { room: RoomSummary; seat: Seat | string };
        const rooms = await api().rooms();
        dispatch({ type: 'rooms', rooms: rooms.some((r) => r.topic === room.topic) ? rooms : [...rooms, room] });
        await a.select(room.topic, 'main');
        return { room, seat: typeof seat === 'string' ? seat : seat?.name ?? 'rkeychat' };
      },
      async bindFolder(topic, folder) {
        await api().bindFolder({ room: topic, folder });
        const rooms = await api().rooms();
        dispatch({ type: 'rooms', rooms });
        const sel = stateRef.current.selected;
        await openThread(topic, sel.topic === topic && sel.conv ? sel.conv : 'main');
      },
      async renameRoom(topic, name) {
        await api().renameRoom({ room: topic, name });
        dispatch({ type: 'rooms', rooms: await api().rooms() });
      },
      async setRoomOrg(topic, org) {
        await api().setRoomOrg({ room: topic, org });
        dispatch({ type: 'rooms', rooms: await api().rooms() });
      },
      async removeRoom(topic) {
        await api().removeRoom({ room: topic });
        const rooms = await api().rooms();
        dispatch({ type: 'rooms', rooms });
        if (stateRef.current.selected.topic === topic) await a.select(null, null);
      },
      async saveAgentRule(topic, name, rule) {
        const d = stateRef.current.details[topic];
        const agents = { ...(d?.charter.agents ?? {}), [name]: { ...(d?.charter.agents?.[name] ?? {}), ...rule } };
        await api().charter({ room: topic, text: d?.charter.text ?? '', order: d?.charter.order ?? [], agents });
        const sel = stateRef.current.selected;
        await openThread(topic, sel.topic === topic && sel.conv ? sel.conv : 'main');
      },
      async loginGrant(topic) {
        await api().loginGrant(topic);
        dispatch({ type: 'feedRemove', id: `ask:${topic}` });
      },
      async loginDeny(topic) {
        await api().loginDeny(topic);
        dispatch({ type: 'feedRemove', id: `ask:${topic}` });
      },
      async answerAsk(topic, ask, choice) {
        const rec = await api().answerAsk({ room: topic, ask, choice });
        dispatch({ type: 'record', topic, rec }); // the card learns its outcome at once; the push repeats it harmlessly
        dispatch({ type: 'feedRemove', id: `perm:${ask}` });
      },
      async openFeedItem(id) {
        const item = stateRef.current.feed.find((x) => x.id === id);
        if (!item) return;
        dispatch({ type: 'feedOpen', id });
        if (item.topic) await a.select(item.topic, item.conv ?? 'main');
      },
      async saveCharter(topic, text) {
        const d = stateRef.current.details[topic];
        await api().charter({ room: topic, text, order: d?.charter.order ?? [], agents: d?.charter.agents ?? {} });
        const sel = stateRef.current.selected;
        await openThread(topic, sel.topic === topic && sel.conv ? sel.conv : 'main');
      },
      async setSeatVia(name, via) {
        await api().setAgentVia({ name, via });
        const sel = stateRef.current.selected;
        if (sel.topic && sel.conv) await openThread(sel.topic, sel.conv);
      },
      // the host's echo (a `seat` control, `applied`) brings a fresh room snapshot, whose seat rows the profile reads
      async setSeat(topic, name, change) {
        await api().seatControl({ room: topic, agent: name, seat: change });
      },
      async setAutoCap(topic, auto) {
        await api().autoCap({ room: topic, auto });
      },
      async setRounds(topic, change) {
        await api().rounds({ room: topic, ...change });
      },
      async setAgentLimit(topic, agent, n) {
        await api().agentLimit({ room: topic, agent, n });
      },
      async react(topic, target, emoji, on) {
        await api().react({ room: topic, target, emoji, on });
      },
      async refreshSetup() {
        try {
          dispatch({ type: 'setup', setup: await api().setup() });
        } catch {}
      },
      async saveSetup(patch) {
        dispatch({ type: 'setup', setup: await api().saveSetup(patch) });
      },
    };
    return a;
  }, []);

  // Boot: state, then the event stream.
  useEffect(() => {
    let alive = true;
    (async () => {
      // Use the fetched list, not stateRef: the dispatch above has not necessarily rendered yet.
      const rooms = await actions.reload();
      if (!alive) return;
      const remembered = readSelected();
      const first = rooms[0]?.topic;
      if (remembered && rooms.some((r) => r.topic === remembered.topic)) await actions.select(remembered.topic, remembered.conv);
      else if (first) await actions.select(first, 'main');
      actions.loadDevices().catch(() => {});
      actions.loadPending().catch(() => {});
      void actions.refreshSetup();
      getApi()
        .loginAsks()
        .then((r) => dispatch({ type: 'loginAsks', asks: r.asking ?? [] }))
        .catch(() => {});
      getApi()
        .asks()
        .then((r) => dispatch({ type: 'asks', asks: r.asks ?? [] }))
        .catch(() => {});
    })();

    const sink = connectEvents({
      onOpen: (reconnect) => {
        dispatch({ type: 'connected', value: true });
        if (reconnect) void actions.reload();
      },
      onDrop: () => dispatch({ type: 'connected', value: false }),
      record: ({ topic, rec, budget }) => {
        dispatch({ type: 'record', topic, rec });
        if (budget !== undefined) dispatch({ type: 'budget', topic, budget: budget ?? null });
      },
      convs: ({ topic, convs }) => dispatch({ type: 'convs', topic, convs }),
      room: (snapshot) => dispatch({ type: 'room', snapshot }),
      rooms: (rooms) => {
        dispatch({ type: 'rooms', rooms });
        // a room arrived or went: what we wait on may have been answered
        actions.loadPending().catch(() => {});
      },
      participants: ({ topic, participants }) => {
        dispatch({ type: 'participants', topic, participants });
        // Presence changed somewhere: the devices' online flags follow it.
        actions.loadDevices().catch(() => {});
      },
      'login-ask': (ask) => dispatch({ type: 'loginAsk', ask }),
      setup: (setup) => dispatch({ type: 'setup', setup }),
      claude: (login) => {
        dispatch({ type: 'claudeLogin', login });
        // a finished login changes whether an agent can run: the setup says so
        if (login.done || (!login.running && !login.error)) void actions.refreshSetup();
      },
      activity: ({ topic, rec }) => dispatch({ type: 'activity', topic, rec }),
      reactions: ({ topic, reactions }) => dispatch({ type: 'reactions', topic, reactions }),
      'agent-state': ({ topic, name, conv, state }) => dispatch({ type: 'agentState', topic, name, conv, state }),
      'agent-error': ({ topic, name, conv, error }) => {
        dispatch({ type: 'agentState', topic, name, conv: conv ?? 'main', state: 'error' });
        console.warn('[agent-error]', name, error);
      },
    });
    return () => {
      alive = false;
      sink.close();
    };
  }, [actions]);

  // A project asked of another device has arrived: open it.
  useEffect(() => {
    const arrived = state.pendingProjects.find((p) => p.topic);
    if (!arrived?.topic) return;
    dispatch({ type: 'pendingDone', id: arrived.id });
    void actions.select(arrived.topic, 'main');
  }, [state.pendingProjects, actions]);

  // The room we were in went away (its owner closed it): land on the first one left.
  useEffect(() => {
    if (!state.ready || state.selected.topic || !state.roomOrder.length) return;
    void actions.select(state.roomOrder[0], 'main');
  }, [state.ready, state.selected.topic, state.roomOrder, actions]);

  const value = useMemo(() => ({ state, dispatch, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside StoreProvider');
  return ctx;
}
