/**
 * After a gap in what this page heard (the event stream reconnected, the daemon caught up a batch, the app came
 * back from the background), every thread may be missing records, the open one included. Marking threads stale
 * is not enough for the open one: it is only fetched again when opened, and it already is, so a reply that arrived
 * while the phone slept stayed missing between the messages around it (debug note 2026-11-27T22-19-20).
 */
export type Selected = { topic: string | null; conv: string | null };

export function catchUp(
  selected: Selected,
  dispatch: (a: { type: 'stale'; topic?: string }) => void,
  select: (topic: string, conv: string) => unknown,
  topic?: string,
): boolean {
  dispatch(topic ? { type: 'stale', topic } : { type: 'stale' });
  if (!selected.topic || !selected.conv || (topic && selected.topic !== topic)) return false;
  void select(selected.topic, selected.conv);
  return true;
}

/** Back on screen after at least this long hidden: assume pushes were lost while the page was frozen. */
export const HIDDEN_GAP_MS = 5_000;
