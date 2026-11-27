import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeWithPending, type ChatMessage } from '../../src/features/chat/chatRules.ts'
import {
  applyReaction, firstUnreadKey, insertMention, mentionOptions, mentionQuery, mentionsMe, quoteText, readPoint, readReaction, REACTIONS,
  replaceReactions, resolveMentions, segmentMessage, summarizeReactions, unreadLabel, type Reaction,
} from '../../src/features/chat/chatSocial.ts'

const [me, asha, ashaK, ben] = ['m-me', 'm-asha', 'm-ashak', 'm-ben']
const members = [{ id: asha, name: 'Asha' }, { id: ashaK, name: 'Asha K' }, { id: ben, name: 'Ben Ito' }]

const row = (id: string, sender: string, at: string): ChatMessage => ({
  id, group_id: 'g', sender_id: sender, body: id, client_id: `c-${id}`, created_at: at, reply_to: null, mentions: [], mentions_everyone: false,
})

test('the tapback set matches the database check, ✅ included', () => {
  assert.deepEqual([...REACTIONS], ['👍', '❤️', '😂', '😮', '😢', '🙏', '✅'])
  assert.equal(readReaction({ message_id: 'm', member_id: me, emoji: '❤' }), null, 'a heart without the emoji selector is not ours')
  assert.deepEqual(readReaction({ message_id: 'm', member_id: me, emoji: '❤️', group_id: 'g' }), { message_id: 'm', member_id: me, emoji: '❤️' })
})

test('reactions toggle, count per emoji in tapback order, and know which are mine', () => {
  let list: Reaction[] = []
  list = applyReaction(list, { message_id: 'm1', member_id: ben, emoji: '😂' }, true)
  list = applyReaction(list, { message_id: 'm1', member_id: me, emoji: '👍' }, true)
  list = applyReaction(list, { message_id: 'm1', member_id: ben, emoji: '👍' }, true)
  const same = applyReaction(list, { message_id: 'm1', member_id: ben, emoji: '👍' }, true)
  assert.equal(same, list, 'already on: unchanged (no re-render)')
  assert.deepEqual(summarizeReactions(list, 'm1', me), [
    { emoji: '👍', count: 2, mine: true, memberIds: [me, ben] },
    { emoji: '😂', count: 1, mine: false, memberIds: [ben] },
  ])
  list = applyReaction(list, { message_id: 'm1', member_id: me, emoji: '👍' }, false)
  assert.deepEqual(summarizeReactions(list, 'm1', me).map((entry) => [entry.emoji, entry.count, entry.mine]), [['👍', 1, false], ['😂', 1, false]])
  assert.deepEqual(summarizeReactions(list, 'other', me), [])
  // A fresh read for some messages replaces what was known about those only.
  const refreshed = replaceReactions(list, ['m1'], [{ message_id: 'm1', member_id: me, emoji: '✅' }, { message_id: 'm9', member_id: me, emoji: '✅' }])
  assert.deepEqual(refreshed, [{ message_id: 'm1', member_id: me, emoji: '✅' }])
})

test('typing @ opens the picker for the word at the caret', () => {
  assert.deepEqual(mentionQuery('hey @as', 7), { start: 4, query: 'as' })
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(mentionQuery('ok @Asha K', 10), { start: 3, query: 'Asha K' }, 'names have spaces')
  assert.equal(mentionQuery('mail me@home', 12), null, 'not inside a word')
  assert.equal(mentionQuery('@asha\nnext', 10), null, 'not across lines')
  assert.equal(mentionQuery('no at sign', 5), null)
})

test('picker options: names (or a word of them) starting with the query, then everyone', () => {
  assert.deepEqual(mentionOptions('as', members).map((option) => option.kind === 'member' ? option.member.name : '@everyone'), ['Asha', 'Asha K'])
  assert.deepEqual(mentionOptions('ito', members).map((option) => option.kind === 'member' ? option.member.id : 'all'), [ben], 'a later word matches')
  assert.deepEqual(mentionOptions('ev', members).map((option) => option.kind), ['everyone'])
  assert.equal(mentionOptions('', members).length, 4, 'everyone listed, plus "everyone"')
  assert.deepEqual(mentionOptions('zz', members), [])
})

test('choosing a name replaces the @query and puts the caret after it', () => {
  assert.deepEqual(insertMention('hey @as tonight?', 4, 7, 'Asha'), { text: 'hey @Asha tonight?', caret: 10 })
  assert.deepEqual(insertMention('@', 0, 1, 'everyone'), { text: '@everyone ', caret: 10 })
})

test('mentions resolve to member ids, longest names first; @everyone is separate', () => {
  assert.deepEqual(resolveMentions('@Asha K and @ben ito, dinner?', members), { ids: [ashaK, ben].sort(), everyone: false })
  assert.deepEqual(resolveMentions('@Asha can you', members), { ids: [asha], everyone: false })
  assert.deepEqual(resolveMentions('@Asha and @Asha K', members), { ids: [asha, ashaK].sort(), everyone: false })
  assert.deepEqual(resolveMentions('@everyone bus at 6', members), { ids: [], everyone: true })
  assert.deepEqual(resolveMentions('mail asha@Asha.com @Ashaa', members), { ids: [], everyone: false }, 'whole names only, after a space')
  assert.deepEqual(resolveMentions('@everyones', members).everyone, false)
})

test('mention chips render by current name; links still work around them', () => {
  const segments = segmentMessage('@Asha K see www.example.com @everyone', [{ id: ashaK, name: 'Asha K' }], true, me)
  assert.deepEqual(segments, [
    { kind: 'mention', text: '@Asha K', me: false },
    { kind: 'text', text: ' see ' },
    { kind: 'link', text: 'www.example.com', href: 'https://www.example.com' },
    { kind: 'text', text: ' ' },
    { kind: 'mention', text: '@everyone', me: true },
  ])
  assert.deepEqual(segmentMessage('@Me you there', [{ id: me, name: 'Me' }], false, me)[0], { kind: 'mention', text: '@Me', me: true })
  assert.deepEqual(segmentMessage('@Asha typed but not mentioned', [], false, me), [{ kind: 'text', text: '@Asha typed but not mentioned' }])
})

test('a message mentions me when it names me or everyone, and is not mine', () => {
  assert.equal(mentionsMe({ senderId: ben, mentions: [me], mentionsEveryone: false }, me), true)
  assert.equal(mentionsMe({ senderId: ben, mentions: [], mentionsEveryone: true }, me), true)
  assert.equal(mentionsMe({ senderId: me, mentions: [], mentionsEveryone: true }, me), false)
  assert.equal(mentionsMe({ senderId: ben, mentions: [asha], mentionsEveryone: false }, me), false)
})

test('the unread divider: the first message from others after my read point', () => {
  const messages = mergeWithPending([
    row('1', ben, '2026-11-27T10:00:00Z'),
    row('2', me, '2026-11-27T10:05:00Z'),
    row('3', ben, '2026-11-27T10:06:00Z'),
  ], [])
  assert.equal(firstUnreadKey(messages, '2026-11-27T10:00:00Z', me), messages[2].key, 'my own message is never unread')
  assert.equal(firstUnreadKey(messages, '2026-11-27T10:06:00Z', me), null, 'all read')
  assert.equal(firstUnreadKey(messages, null, me), null, 'unknown: no divider')
  assert.equal(readPoint(messages), '2026-11-27T10:06:00Z')
  assert.equal(readPoint([]), null)
  assert.equal(unreadLabel(7), '7')
  assert.equal(unreadLabel(100), '99+')
})

test('a quote is one line, cut at 120 characters', () => {
  assert.equal(quoteText('Who has\n\nthe address?'), 'Who has the address?')
  const long = quoteText('x'.repeat(200))
  assert.equal(Array.from(long).length, 120)
  assert.ok(long.endsWith('…'))
})
