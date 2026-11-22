// Project requests between the owner's devices (docs/projects-home-and-sync.md §1), the pure part: what a
// 'project' control asks for, which ones this device still waits on, and which this device must act on.

// a folder name from a project name: lower case, letters digits - _ only
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'

const DAY = 86_400_000
// a request nobody answered in a month is stale: the device it named is gone, or the project was made by hand
export const REQUEST_TTL = 30 * DAY

// What a signed 'project' record asks for, read from the record itself: never from a viewed copy, whose `name`
// is the author's display name (the bug that once made a project called "guy").
export function requestOf (rec) {
  if (!rec || rec.kind !== 'control' || rec.action !== 'project') return null
  return { id: rec.id, name: String(rec.name ?? '').trim() || 'New project', home: rec.home ?? null, text: rec.text, org: rec.org ?? undefined, author: rec.author, ts: rec.ts }
}

// The requests this device must act on: those naming it as home, not yet done or in flight.
export function requestsFor (records, deviceRef, { done = [], inflight = new Set() } = {}) {
  return records.map(requestOf).filter((r) => r && r.home?.device === deviceRef && !done.includes(r.id) && !inflight.has(r.id))
}

// What this device asked other devices for and has not seen arrive, newest first.
//   rooms: [{ name, requests: [record], answered: [request ids this room's app note names], devices: [{ ref, name, online }] }]
//   mine:  the refs of this device's own human keys (the requests it wrote)
export function pendingProjectsOf (rooms, mine, now = Date.now()) {
  const answered = new Set(rooms.flatMap((r) => r.answered ?? []))
  const out = []
  for (const room of rooms) {
    for (const rec of room.requests ?? []) {
      const r = requestOf(rec)
      if (!r || !mine.includes(r.author) || answered.has(r.id) || now - r.ts > REQUEST_TTL) continue
      const dev = (room.devices ?? []).find((d) => d.ref === r.home?.device)
      out.push({ id: r.id, name: r.name, asked: r.home?.name || dev?.name || 'another device', home: r.home?.device ?? null, via: room.name, ts: r.ts, online: !!dev?.online })
    }
  }
  return out.sort((a, b) => b.ts - a.ts)
}
