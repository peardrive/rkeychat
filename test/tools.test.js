import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTools, resolveTools, describeTools, LAB } from '../src/tools.js'

test('the default is the lab preset, with the folders beside the project readable except the _ ones', () => {
  const { allow, deny } = resolveTools(undefined, '/Users/guy/Anjou/peardrive')
  for (const r of LAB) assert.ok(allow.includes(r), r)
  assert.ok(allow.includes('Read(//Users/guy/Anjou/**)'))
  assert.deepEqual(deny, ['Read(//Users/guy/Anjou/_*/**)'])
  assert.ok(allow.includes('Bash(git:*)'))
  assert.ok(allow.includes('Bash(npm:*)'))
  assert.ok(allow.includes('Bash(rkeychat:*)'))
})

test('none allows nothing extra; a list is passed through as given', () => {
  assert.deepEqual(resolveTools('none', '/x/y'), { allow: [], deny: [] })
  assert.deepEqual(resolveTools(['Read', 'Bash(git:*)'], '/x/y'), { allow: ['Read', 'Bash(git:*)'], deny: [] })
  assert.throws(() => resolveTools('everything', '/x/y'), /unknown tools preset/)
})

test('--tools parses presets and comma lists; empty means the default', () => {
  assert.equal(parseTools(undefined), undefined)
  assert.equal(parseTools(''), undefined)
  assert.equal(parseTools('lab'), 'lab')
  assert.equal(parseTools(' none '), 'none')
  assert.deepEqual(parseTools('Read, Edit,Bash(git:*)'), ['Read', 'Edit', 'Bash(git:*)'])
  assert.deepEqual(parseTools(['Read', ' Edit ']), ['Read', 'Edit'])
})

test('agent list describes the setting in one line', () => {
  assert.match(describeTools(), /lab preset/)
  assert.match(describeTools('none'), /asks for everything/)
  assert.equal(describeTools(['Read']), 'tools: Read')
})
