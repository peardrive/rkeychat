/**
 * The store: one reducer, one context, and the actions that talk to the daemon. Pushes from
 * /api/events are dispatched straight into the reducer.
 */
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { getApi } from '../api';
import { connectEvents } from '../events';
import type { Conversation, Device, PendingProject, RoomSummary } from '../types';
import { convKey, initialState, reducer, type Action, type State } from './reducer';
import type { Seat } from '../types';

const SELECTED_KEY = 'rkc.app.selected';
const PAGE = 60;

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
  createProject(opts: { folder?: string; name?: string; home?: string; prompt?: string }): Promise<{ room: RoomSummary; seat: string } | PendingProject>;
  loadDevices(): Promise<Device[]>;
  bindFolder(topic: string, folder: string): Promise<void>;
  saveCharter(topic: string, text: string): Promise<void>;
  setSeatVia(name: string, via: 'acp' | 'cli'): Promise<void>;
  react(topic: string, target: string, emoji: string, on: boolean): Promise<void>;
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
          dispatch({ type: 'init', device: { name: res.device.name, ref: res.device.ref, human }, rooms: res.rooms, current: null });
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
      async createProject(opts) {
        const res = await api().createProject(opts);
        if ('pending' in res && res.pending) {
          dispatch({ type: 'pendingProject', id: res.id, name: opts.name ?? '', asked: res.asked });
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
      async react(topic, target, emoji, on) {
        await api().react({ room: topic, target, emoji, on });
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
    })();

    const sink = connectEvents({
      onOpen: (reconnect) => {
        dispatch({ type: 'connected', value: true });
        if (reconnect) void actions.reload();
      },
      onDrop: () => dispatch({ type: 'connected', value: false }),
      record: ({ topic, rec }) => dispatch({ type: 'record', topic, rec }),
      convs: ({ topic, convs }) => dispatch({ type: 'convs', topic, convs }),
      room: (snapshot) => dispatch({ type: 'room', snapshot }),
      rooms: (rooms) => dispatch({ type: 'rooms', rooms }),
      participants: ({ topic, participants }) => dispatch({ type: 'participants', topic, participants }),
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

  const value = useMemo(() => ({ state, dispatch, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside StoreProvider');
  return ctx;
}
