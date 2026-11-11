// Which slice of a room's history a page asks for. The chat never holds the whole history: it keeps a window
// around where the reader is and asks for more at either edge. This is the arithmetic of that request, kept
// apart from Room so it can be tested on plain arrays.
//
// `list` is ordered oldest first and holds only what the feed shows. Exactly one of `before`, `after` or
// `around` names a record id; with none, the newest `limit` records. Returns the [start, end) of the slice and
// whether there is more on either side, or null when the named id is not in the list.

export const PAGE_MAX = 200
export const FEED_PAGE = 50 // what a room snapshot carries, and what the page asks for at a time

export function windowOf (list, { before, after, around, limit = 50 } = {}) {
  limit = Math.floor(Number(limit))
  limit = limit > 0 ? Math.min(PAGE_MAX, limit) : 50 // missing, zero, negative or not a number: the default
  const at = (id) => list.findIndex((r) => r.id === id)
  let start; let end
  if (around) {
    const i = at(around); if (i < 0) return null
    // the named record sits in the middle, and a window that hits either end slides to keep its size
    start = Math.max(0, i - Math.floor(limit / 2))
    end = Math.min(list.length, start + limit)
    start = Math.max(0, end - limit)
  } else if (before) {
    const i = at(before); if (i < 0) return null
    end = i; start = Math.max(0, end - limit)
  } else if (after) {
    const i = at(after); if (i < 0) return null
    start = i + 1; end = Math.min(list.length, start + limit)
  } else {
    end = list.length; start = Math.max(0, end - limit)
  }
  return { start, end, hasOlder: start > 0, hasNewer: end < list.length }
}
