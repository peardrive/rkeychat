/**
 * The rows of "Folders this project can see" (components/ProjectAccess.tsx), with no screen: kept apart so the
 * rules are tested without React Native.
 */
import type { AccessItem } from 'pearkit';
import type { GrantsInfo } from '../types';

/** PearKit's shortPath, the same rule: a path under home with a tilde. */
const tilde = (path: string, home: string | null) => {
  if (!home) return path;
  const h = home.replace(/\/+$/, '');
  return path === h ? '~' : path.startsWith(h + '/') ? '~' + path.slice(h.length) : path;
};

/** The rows: the folder, what is beside it, then each grant with where it came from. */
export function accessItems(info: GrantsInfo): AccessItem[] {
  const home = info.home ?? null;
  const items: AccessItem[] = [];
  if (info.folder) items.push({ id: 'self', title: tilde(info.folder, home), detail: 'the project folder', fixed: true });
  if (info.beside) items.push({ id: 'beside', title: tilde(info.beside, home), detail: 'beside the project, except its _ folders', fixed: true });
  for (const g of info.grants) {
    const m = /^(Read|Edit)\(\/(\/.+)\/\*\*\)$/.exec(g.rule);
    const how = g.from === 'ask' ? `allowed from a question, by ${g.by}` : `added by ${g.by}`;
    if (m) items.push({ id: g.rule, title: tilde(m[2], home), detail: m[1] === 'Edit' ? `may change files · ${how}` : how });
    else items.push({ id: g.rule, title: g.label, icon: 'tick', path: false, detail: how });
  }
  return items;
}

