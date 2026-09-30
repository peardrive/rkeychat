// Turn-taking and the round budget, computed deterministically from the shared
// log so every daemon reaches the same answer without coordinating.
//
// A "round" is one hop of agent-to-agent conversation. Guy's message is depth
// 0; an agent's reply to it is depth 1; a reply to that is depth 2; and so on.
// Agents may post while depth <= limit. The limit is 3 by default and resets
// on every human message; admin controls extend it, lift it (unlimited or until
// a time), or pause everything.
//
// Per-agent controls (control.agent set): 'pause'/'resume' one agent, and
// 'limit' n = that agent may post at most n times between human messages
// ('limit' with no n lifts it). These are standing settings: they persist
// across human messages until changed.

export const DEFAULT_ROUNDS = 3

export function budget (log, { now = Date.now(), defaultRounds = DEFAULT_ROUNDS } = {}) {
  let limit = defaultRounds
  let unlimited = false
  let until = null
  let paused = false
  let maxDepth = 0
  const agentPaused = new Set()
  const agentLimit = new Map()
  const agentPosts = new Map() // since the last human message

  for (const r of log) {
    if (r.kind === 'control' && r.agent) {
      if (r.action === 'pause') agentPaused.add(r.agent)
      if (r.action === 'resume') agentPaused.delete(r.agent)
      if (r.action === 'limit') {
        if (Number(r.n) > 0) agentLimit.set(r.agent, Number(r.n))
        else agentLimit.delete(r.agent)
      }
    } else if (r.kind === 'control') {
      switch (r.action) {
        case 'extend': limit += Math.max(1, Number(r.n) || 1); break
        case 'unlimited': unlimited = true; break
        case 'until': until = Number(r.until) || null; break
        case 'pause': paused = true; break
        case 'resume': paused = false; break
        case 'reset': limit = defaultRounds; unlimited = false; until = null; break
      }
    } else if (r.kind === 'msg' && r.via === 'mirror') {
      // a mirrored terminal exchange is a record of what was said, not a live
      // turn: it neither resets nor spends rounds
    } else if (r.kind === 'msg') {
      if (r.human) {
        // a human speaking resets the round count (but not a standing
        // unlimited/until grant — that's an explicit "run all night")
        limit = defaultRounds
        maxDepth = 0
        agentPosts.clear()
      } else {
        maxDepth = Math.max(maxDepth, r.depth)
        agentPosts.set(r.name, (agentPosts.get(r.name) ?? 0) + 1)
      }
    }
  }

  const open = unlimited || (until !== null && now < until)
  return {
    paused,
    unlimited,
    until,
    limit,
    used: maxDepth,
    remaining: open ? Infinity : Math.max(0, limit - maxDepth),
    agents: { paused: [...agentPaused], limits: Object.fromEntries(agentLimit), posts: Object.fromEntries(agentPosts) },
    // may `agent` post a reply at this depth?
    allows: (depth, agent) => {
      if (paused || (agent && agentPaused.has(agent))) return false
      if (agent && agentLimit.has(agent) && (agentPosts.get(agent) ?? 0) >= agentLimit.get(agent)) return false
      return open || depth <= limit
    }
  }
}

// Should `agent` (a name) be woken by message `m`?
//   - never by its own messages
//   - a human message with no mentions goes to every agent ("open floor")
//   - otherwise only when mentioned
//   - a human replying to a specific message (re) addresses its author, not the floor
export function addressedTo (m, agent, byId = null) {
  if (m.kind !== 'msg' || m.name === agent || m.via === 'mirror' || m.redacted) return false
  if (m.mentions.includes(agent)) return true
  if (m.human && m.re?.length && byId) return m.re.some((id) => byId.get(id)?.name === agent)
  if (m.human && m.mentions.length === 0 && !m.re?.length) return true
  return false
}

export const replyDepth = (triggers) => 1 + Math.max(0, ...triggers.map((t) => (t.human ? 0 : t.depth)))
