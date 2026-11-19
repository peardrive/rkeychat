/**
 * The four pages behind the dock, remembered across launches, and the organization filter of Projects.
 */
import type { RoomSummary } from '../types';
import { orgOf } from './selectors';

export type DockPage = 'home' | 'activity' | 'projects' | 'settings';
export const DOCK_PAGES: DockPage[] = ['home', 'activity', 'projects', 'settings'];
export const isDockPage = (v: unknown): v is DockPage => typeof v === 'string' && (DOCK_PAGES as string[]).includes(v);

const DOCK_KEY = 'rkc.app.dock';
const ORG_KEY = 'rkc.app.org-filter';

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const ls = (): Store | null => (typeof localStorage !== 'undefined' ? localStorage : null);

export function readDock(store: Store | null = ls()): DockPage {
  const v = store?.getItem(DOCK_KEY);
  return isDockPage(v) ? v : 'home';
}
export function writeDock(page: DockPage, store: Store | null = ls()) {
  try {
    store?.setItem(DOCK_KEY, page);
  } catch {}
}

/** `'all'`, an organization's name, or `'none'` for the projects without one. */
export type OrgFilter = 'all' | 'none' | string;

export function readOrgFilter(store: Store | null = ls()): OrgFilter {
  return store?.getItem(ORG_KEY) || 'all';
}
export function writeOrgFilter(f: OrgFilter, store: Store | null = ls()) {
  try {
    store?.setItem(ORG_KEY, f);
  } catch {}
}

export function filterByOrg(rooms: RoomSummary[], filter: OrgFilter): RoomSummary[] {
  if (filter === 'all') return rooms;
  if (filter === 'none') return rooms.filter((r) => !orgOf(r));
  return rooms.filter((r) => orgOf(r) === filter);
}

/** The tabs of Projects: All, then each organization, then "No organization" when some projects have none. */
export function orgTabs(rooms: RoomSummary[]): { key: OrgFilter; name: string; count?: number }[] {
  const counts = new Map<string, number>();
  let none = 0;
  for (const r of rooms) {
    const o = orgOf(r);
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
    else none += 1;
  }
  const orgs = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ key: name, name, count }));
  return [{ key: 'all', name: 'All', count: rooms.length }, ...orgs, ...(none && orgs.length ? [{ key: 'none', name: 'No organization', count: none }] : [])];
}

/** The tab to the left or right of `current`, for a swipe; stays put at the ends. */
export function neighbourTab(tabs: { key: OrgFilter }[], current: OrgFilter, direction: 1 | -1): OrgFilter {
  const i = Math.max(0, tabs.findIndex((t) => t.key === current));
  const j = Math.min(tabs.length - 1, Math.max(0, i + direction));
  return tabs[j]?.key ?? current;
}
