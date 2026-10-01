// Room invite codes (rkc1.…): name, sharelink, root, topic.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString())

export function encodeInvite (room) { return 'rkc1.' + b64({ n: room.name, s: room.sharelink, r: room.root, t: room.topic }) }
export function decodeInvite (code) {
  const s = String(code ?? '').trim()
  if (!s.startsWith('rkc1.')) throw new Error('that isn\'t an rKeyChat invite (they start with rkc1.)')
  const { n, s: sharelink, r: root, t: topic } = unb64(s.slice(5))
  return { name: n, sharelink, root, topic }
}
