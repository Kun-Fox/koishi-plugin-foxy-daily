'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { JsonState } = require('../lib/state')
const { buildWindow, filterMemories, generateDigest, dateKey } = require('../lib/digest')
const { CommentRunner, commentKey } = require('../lib/comments')
const { LikeRunner } = require('../lib/likes')
const { PublicFeedRunner, feedKey } = require('../lib/public-feed')
const { parseCookieHeader, extractUin, hasQzoneTicket, normalizeImages } = require('../lib/qzone')
const { registerQzoneTools, allowed } = require('../lib/tools')
const { FoxyDailyService, Config, apply } = require('../lib/index')

const results = []

async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok - ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`not ok - ${name}`)
    console.error(error.stack || error.message)
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-daily-'))
}

function memory(id, content, createdAt, type = 'fact') {
  return {
    id,
    presetId: 'foxy3',
    speakerKeys: ['foxy3'],
    type,
    status: 'active',
    content,
    createdAt,
    updatedAt: createdAt,
  }
}

async function main() {
  await test('buildWindow uses previous day before 06:00 and explicit dates', () => {
    const early = buildWindow({}, new Date(2026, 10, 5, 2, 30))
    assert.equal(early.date, '2026-11-04')
    assert.equal(early.start.getHours(), 0)
    assert.equal(early.end.getHours(), 23)

    const late = buildWindow({}, new Date(2026, 10, 5, 23, 50))
    assert.equal(late.date, '2026-11-05')

    const explicit = buildWindow({ date: '2026-10-31' }, new Date(2026, 10, 5, 12))
    assert.equal(explicit.date, '2026-10-31')
    assert.equal(explicit.start.getDate(), 31)
    assert.equal(explicit.end.getDate(), 31)
    assert.throws(() => buildWindow({ date: '2026-13-01' }), /日期格式无效/)
  })

  await test('filterMemories keeps only the requested window', () => {
    const start = new Date(2026, 10, 4, 0, 0)
    const end = new Date(2026, 10, 4, 23, 59, 59, 999)
    const entries = [
      memory('a', 'before', new Date(2026, 10, 3, 23, 59)),
      memory('b', 'inside', new Date(2026, 10, 4, 12, 0)),
      memory('c', 'after', new Date(2026, 10, 5, 0, 0)),
      memory('d', 'bad', 'not-a-date'),
    ]
    assert.deepEqual(filterMemories(entries, start, end).map((entry) => entry.id), ['b'])
  })

  await test('JsonState persists, marks and is idempotent', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'state.json')
    const state = new JsonState(file)
    await state.load()
    state.markPublished('2026-11-04', { postId: 'p1' })
    await state.save()

    const reloaded = new JsonState(file)
    await reloaded.load()
    assert.equal(reloaded.data.published['2026-11-04'].postId, 'p1')
    assert.equal(reloaded.data.pending, null)

    reloaded.setPending({ date: '2026-11-05', attempts: 1, nextAttemptAt: 1, lastError: 'x' })
    reloaded.markSkipped('2026-11-05', 'empty')
    await reloaded.save()
    assert.equal(reloaded.data.pending, null)
    assert.equal(reloaded.data.skipped['2026-11-05'].reason, 'empty')

    reloaded.setCommentState('p1', 'c1', { status: 'replied' })
    assert.equal(reloaded.commentState('p1', 'c1').status, 'replied')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('cookie parser finds uin and qzone ticket', () => {
    const jar = parseCookieHeader('uin=o123456789; p_skey=abc; skey=def; other=1')
    assert.equal(extractUin(jar), '123456789')
    assert.equal(hasQzoneTicket(jar), true)
    assert.equal(hasQzoneTicket({ p_skey: 'x' }), true)
    assert.equal(hasQzoneTicket({}), false)
  })

  await test('CommentRunner replies once to a new comment and skips own/old/replied', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    state.setCommentState('p1', 'old', { status: 'replied' })
    let replies = 0
    const posts = [{
      id: 'p1',
      authorId: 'bot',
      content: '今天的动态',
      comments: [
        { id: 'c1', kind: 'comment', author: { id: 'u1', nickname: 'A' }, content: '好棒', createdAt: new Date() },
        { id: 'own', kind: 'comment', author: { id: 'bot', nickname: 'foxy' }, content: '自评', createdAt: new Date() },
        { id: 'ancient', kind: 'comment', author: { id: 'u2', nickname: 'B' }, content: '旧评论', createdAt: new Date('2020-01-01') },
        { id: 'old', kind: 'comment', author: { id: 'u3', nickname: 'C' }, content: '已回复', createdAt: new Date() },
      ],
    }]
    const qzone = {
      accountId: 'bot',
      async listSelfFeeds() { return { items: [{ id: 'p1' }] } },
      async getPost() { return posts[0] },
      async reply() { replies++; return { outcome: 'verified' } },
    }
    const runner = new CommentRunner({
      qzone,
      state,
      config: {
        enableCommentAutoReply: true,
        monitorPostLimit: 10,
        commentMaxAgeHours: 72,
        commentMaxRepliesPerRound: 3,
        commentMaxAttempts: 3,
        autoReplyAllCommenters: true,
      },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: '谢谢喜欢' }) }),
      getPersona: async () => '',
    })
    const report = await runner.runOnce()
    assert.equal(report.replied, 1)
    assert.equal(replies, 1)
    assert.equal(state.commentState('p1', commentKey(posts[0].comments[0])).status, 'replied')
    assert.equal(state.commentState('p1', 'old').status, 'replied')
    const again = await runner.runOnce()
    assert.equal(again.replied, 0)
    assert.equal(replies, 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('CommentRunner separates comments that share the same numeric id', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    // Legacy state from the old implementation only had the raw comment id.
    state.setCommentState('p1', '2', { status: 'replied', reply: '旧回复' })
    const comments = [
      {
        id: '2',
        kind: 'reply',
        author: { id: 'u1', nickname: 'nogitsune' },
        content: '不是我考',
        replyToUser: { id: 'bot', nickname: 'Foxy' },
        createdAt: new Date(),
      },
      {
        id: '2',
        kind: 'comment',
        author: { id: 'u2', nickname: '筱柒' },
        content: '强强',
        createdAt: new Date(),
      },
    ]
    assert.notEqual(commentKey(comments[0]), commentKey(comments[1]))
    const qzone = {
      accountId: 'bot',
      async listSelfFeeds() { return { items: [{ id: 'p1' }] } },
      async getPost() {
        return { id: 'p1', authorId: 'bot', content: '动态', comments }
      },
      async reply(_post, comment) {
        return { outcome: 'verified', repliedTo: comment.content }
      },
    }
    const runner = new CommentRunner({
      qzone,
      state,
      config: {
        enableCommentAutoReply: true,
        monitorPostLimit: 10,
        commentMaxAgeHours: 72,
        commentMaxRepliesPerRound: 3,
        commentMaxAttempts: 3,
        autoReplyAllCommenters: true,
      },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: '回复' }) }),
      getPersona: async () => '',
    })
    const pending = await runner.listUnreplied()
    assert.match(pending, /强强/)
    assert.doesNotMatch(pending, /不是我考/)
    const report = await runner.runOnce()
    assert.equal(report.replied, 1)
    assert.equal(state.commentState('p1', commentKey(comments[1])).status, 'replied')
    assert.equal(state.commentState('p1', commentKey(comments[0])), undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('CommentRunner does not assign legacy state to Foxy own reply', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    state.setCommentState('p1', '1', { status: 'replied', reply: '考完记得补觉喵' })
    const comments = [
      {
        id: '1',
        kind: 'comment',
        author: { id: 'u1', nickname: 'nogitsune' },
        content: '😄',
        createdAt: new Date(),
      },
      {
        id: '1',
        kind: 'reply',
        author: { id: 'bot', nickname: 'Ai Foxy' },
        content: '考完记得补觉喵',
        replyToUser: { id: 'u1', nickname: 'nogitsune' },
        createdAt: new Date(),
      },
    ]
    const qzone = {
      accountId: 'bot',
      async listSelfFeeds() { return { items: [{ id: 'p1' }] } },
      async getPost() {
        return { id: 'p1', authorId: 'bot', content: '动态', comments }
      },
    }
    const runner = new CommentRunner({
      qzone,
      state,
      config: { commentMaxAgeHours: 72, commentMaxAttempts: 3, autoReplyAllCommenters: true },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: '回复' }) }),
      getPersona: async () => '',
    })
    assert.equal(runner._commentState({ id: 'p1' }, comments[0], comments)?.status, 'replied')
    assert.equal(runner._commentState({ id: 'p1' }, comments[1], comments), undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('CommentRunner respects allow list when autoReplyAllCommenters is false', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    const qzone = {
      accountId: 'bot',
      async listSelfFeeds() { return { items: [{ id: 'p1' }] } },
      async getPost() {
        return {
          id: 'p1', authorId: 'bot', content: 'x',
          comments: [{ id: 'c1', kind: 'comment', author: { id: 'stranger', nickname: 'S' }, content: 'hi', createdAt: new Date() }],
        }
      },
      async reply() { throw new Error('should not reply') },
    }
    const runner = new CommentRunner({
      qzone,
      state,
      config: {
        enableCommentAutoReply: true,
        monitorPostLimit: 10,
        commentMaxAgeHours: 72,
        commentMaxRepliesPerRound: 3,
        commentMaxAttempts: 3,
        autoReplyAllCommenters: false,
        allowUserIds: ['u1'],
      },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: 'x' }) }),
      getPersona: async () => '',
    })
    const report = await runner.runOnce()
    assert.equal(report.replied, 0)
    assert.equal(report.skipped, 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('generateDigest validates tool output and retries through agentFactory', async () => {
    let calls = 0
    const agent = {
      invoke: async () => {
        calls++
        return [{ tool: 'publish_daily_digest', toolInput: { action: 'publish', content: '今天很开心。' } }]
      },
    }
    const result = await generateDigest({
      model: {},
      persona: 'foxy',
      memories: [memory('m1', '今天很开心', new Date())],
      window: { date: '2026-11-05', label: '2026-11-05 00:00–23:59' },
      assistantLabel: 'foxy3',
      agentFactory: () => agent,
      maxAttempts: 1,
    })
    assert.equal(result.value.action, 'publish')
    assert.equal(result.value.content, '今天很开心。')
    assert.equal(calls, 1)
  })

  await test('generateDigest reports invalid tool output', async () => {
    const agent = { invoke: async () => [{ tool: 'other', toolInput: {} }] }
    const result = await generateDigest({
      model: {},
      persona: '',
      memories: [memory('m1', 'x', new Date())],
      window: { date: '2026-11-05', label: 'x' },
      assistantLabel: 'foxy3',
      agentFactory: () => agent,
      maxAttempts: 1,
    })
    assert.equal(result.value, null)
    assert.match(result.error, /意外的工具/)
  })

  await test('tool registration respects allow list and registers ChatLuna/Character fields', async () => {
    const calls = { chatluna: [], character: [] }
    const ctx = {
      chatluna: {
        platform: {
          registerTool(name) { calls.chatluna.push(name); return () => {} },
        },
      },
      chatluna_character: {
        registerReplyToolField(field) { calls.character.push(field.name); return () => {} },
      },
    }
    const service = { handleTool: async () => 'ok' }
    const config = {
      allowUserIds: ['u1'],
      monitorPostLimit: 10,
      toolEnabled: true,
      characterToolEnabled: true,
    }
    const dispose = registerQzoneTools(ctx, service, config, { warn() {} })
    assert.deepEqual(calls.chatluna.sort(), ['qzone_comments', 'qzone_publish', 'qzone_reply'])
    assert.deepEqual(calls.character.sort(), ['qzone_comments', 'qzone_publish', 'qzone_reply'])
    assert.equal(allowed(config, { userId: 'u1' }), true)
    assert.equal(allowed(config, { userId: 'u2' }), false)
    assert.equal(allowed(config, null), false)
    dispose()
  })

  await test('normalizeImages accepts buffers and rejects unusable values', async () => {
    const images = await normalizeImages([Buffer.from([1, 2, 3])])
    assert.equal(images.length, 1)
    assert.ok(images[0].data instanceof Uint8Array)
    assert.match(images[0].name, /\.jpg$/)
    await assert.rejects(() => normalizeImages([42]), /不支持的配图格式/)
  })

  await test('service publishes, skips empty windows and records failures', async () => {
    const dir = tempDir()
    const logger = { info() {}, warn() {}, debug() {}, error() {} }
    const config = {
      platform: 'auto',
      selfId: '',
      allowUserIds: ['u1'],
      watchUserIds: [],
      stateFile: path.join(dir, 'state.json'),
      debug: false,
      enableDailyDigest: true,
      digestTime: '23:50',
      digestMemoryLimit: 100,
      personaPresetId: 'foxy3',
      persona: '',
      digestModel: 'mock',
      catchUpPreviousDay: true,
      enableCommentAutoReply: false,
      commentPollIntervalMinutes: 5,
      commentMaxAgeHours: 72,
      commentMaxRepliesPerRound: 3,
      commentMaxAttempts: 3,
      autoReplyAllCommenters: true,
      monitorPostLimit: 10,
      toolEnabled: false,
      characterToolEnabled: false,
      enableMemeImage: false,
      maxImages: 9,
    }
    const ctx = {
      baseDir: dir,
      logger: () => logger,
      chatluna: {},
      chatluna_living_memory: {},
    }
    const service = new FoxyDailyService(ctx, config)
    await service.state.load()
    service.listMemories = async () => []
    service.getPersona = async () => ''
    service.getModel = async () => ({})
    const empty = await service.runDigest('2026-11-05', 'manual')
    assert.equal(empty.result, 'skipped-empty')

    service.listMemories = async () => [memory('m1', '今天很开心', new Date(2026, 10, 5, 12))]
    service.agentFactory = () => ({
      invoke: async () => [{ tool: 'publish_daily_digest', toolInput: { action: 'publish', content: '今天很开心。' } }],
    })
    service.publishContent = async () => ({ outcome: 'verified', post: { id: 'p1' } })
    const published = await service.runDigest('2026-11-05', 'manual')
    assert.equal(published.result, 'published')
    assert.equal(service.state.data.published['2026-11-05'].postId, 'p1')

    service.publishContent = async () => { throw new Error('network down') }
    await assert.rejects(() => service.runDigest('2026-11-05', 'scheduled'), /network down/)
    assert.equal(service.state.data.pending.date, '2026-11-05')
    assert.match(service.state.data.pending.lastError, /network down/)

    service.publishContent = async () => ({ outcome: 'unknown' })
    const unknown = await service.runDigest('2026-11-05', 'manual')
    assert.equal(unknown.result, 'unknown')
    assert.equal(service.state.data.pending.unknown, true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('FoxyDailyService resolves Character preset suffix and meme images', async () => {
    const dir = tempDir()
    const ctx = {
      baseDir: dir,
      logger: () => ({ info() {}, warn() {}, debug() {} }),
      chatluna: {},
      chatluna_living_memory: {},
      chatluna_memes: {
        async getCollections() { return ['cats'] },
        async getCollectionResourcePage(collection, query) {
          assert.equal(collection, 'cats')
          assert.equal(query.search, '开心')
          return { items: [{ type: 'local', filename: 'happy.jpg', tags: ['开心'] }] }
        },
        async getLocalImageBuffer(collection, filename) {
          assert.equal(collection, 'cats')
          assert.equal(filename, 'happy.jpg')
          return { buffer: Buffer.from('meme'), mime: 'image/jpeg' }
        },
      },
    }
    const config = {
      stateFile: 'data/foxy-daily/state.json',
      personaPresetId: 'foxy3',
      characterPresetId: 'foxy3',
      personaKind: 'character',
      enableMemeImage: true,
      maxImages: 9,
    }
    const service = new FoxyDailyService(ctx, config)
    assert.equal(service.getPresetId(), 'foxy3（Character）')
    const images = await service.getImages('今天很开心', [], {}, '开心')
    assert.equal(images.length, 1)
    assert.equal(images[0].name, 'happy.jpg')
    assert.equal(Buffer.from(images[0].data).toString(), 'meme')
    service.config.personaKind = 'chatluna'
    assert.equal(service.getPresetId(), 'foxy3')
    service.config.personaPresetId = 'foxy3（Character）'
    assert.equal(service.getPresetId(), 'foxy3（Character）')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('buildWindow supports explicit date range', () => {
    const window = buildWindow({ from: '2026-10-01', to: '2026-10-03' }, new Date(2026, 10, 5, 12))
    assert.equal(window.date, '2026-10-01~2026-10-03')
    assert.equal(window.range, true)
    assert.equal(window.start.getDate(), 1)
    assert.equal(window.end.getDate(), 3)
    assert.throws(() => buildWindow({ from: '2026-10-03' }, new Date()), /同时提供/)
  })

  await test('CommentRunner replies to own nested replies only when addressed to bot', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    const replies = []
    const post = {
      id: 'p1',
      authorId: 'bot',
      content: '动态',
      comments: [
        { id: 'c1', kind: 'comment', author: { id: 'u1' }, content: '一级', createdAt: new Date() },
        { id: 'r1', kind: 'reply', replyTo: { id: 'bot' }, author: { id: 'u2' }, content: '回复机器人', createdAt: new Date() },
        { id: 'r2', kind: 'reply', replyTo: { id: 'u1' }, author: { id: 'u3' }, content: '回复别人', createdAt: new Date() },
      ],
    }
    const qzone = {
      accountId: 'bot',
      async listSelfFeeds() { return { items: [{ id: 'p1' }] } },
      async getPost() { return post },
      async reply(_post, comment, content) { replies.push({ id: comment.id, content }); return { outcome: 'verified' } },
    }
    const runner = new CommentRunner({
      qzone,
      state,
      config: {
        enableCommentAutoReply: true,
        monitorPostLimit: 10,
        commentMaxAgeHours: 72,
        commentMaxRepliesPerRound: 10,
        commentMaxAttempts: 3,
        autoReplyAllCommenters: true,
        replyOwnNested: true,
        nestedReplyOnlyToBot: true,
      },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: '收到' }) }),
      getPersona: async () => '',
    })
    const pending = await runner.listUnreplied()
    assert.match(pending, /\[c1\]/)
    assert.match(pending, /\[r1\]/)
    assert.doesNotMatch(pending, /\[r2\]/)
    const report = await runner.runOnce()
    assert.equal(report.replied, 2)
    assert.deepEqual(replies.map((item) => item.id).sort(), ['c1', 'r1'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('CommentRunner can read and reply to allowed other posts', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    let replies = 0
    const post = {
      id: 'p2',
      authorId: 'friend',
      content: '朋友动态',
      comments: [
        { id: 'c2', kind: 'comment', author: { id: 'u1' }, content: '不错', createdAt: new Date() },
        { id: 'r3', kind: 'reply', replyTo: { id: 'u1' }, author: { id: 'u2' }, content: '楼中楼', createdAt: new Date() },
      ],
    }
    const qzone = {
      accountId: 'bot',
      async listSelfFeeds() { return { items: [] } },
      async listUserFeeds() { return { items: [post] } },
      async getPost() { return post },
      async reply() { replies++; return { outcome: 'verified' } },
    }
    const runner = new CommentRunner({
      qzone,
      state,
      config: {
        enableCommentAutoReply: true,
        monitorPostLimit: 10,
        commentMaxAgeHours: 72,
        commentMaxRepliesPerRound: 10,
        commentMaxAttempts: 3,
        enableOtherPostComments: true,
        otherPostCommentUserIds: ['friend'],
        replyOtherNested: true,
        nestedReplyOnlyToBot: false,
        otherPostReplyAllCommenters: true,
      },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: '谢谢' }) }),
      getPersona: async () => '',
    })
    const report = await runner.runOnce()
    assert.equal(report.replied, 2)
    assert.equal(replies, 2)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('LikeRunner respects whitelist and blacklist', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    const liked = []
    const qzone = {
      accountId: 'bot',
      async listFriendsFeeds() {
        return { items: [
          { id: 'a', authorId: 'u1' },
          { id: 'b', authorId: 'u2' },
          { id: 'c', authorId: 'bot' },
        ] }
      },
      async like(post) { liked.push(post.id); return { outcome: 'verified' } },
    }
    const runner = new LikeRunner({
      qzone,
      state,
      config: { enableAutoLike: true, autoLikeFeedLimit: 20, autoLikeMaxPerRound: 5, autoLikeUserIds: [], autoLikeBlockUserIds: ['u2'] },
      logger: { info() {}, warn() {} },
    })
    const report = await runner.runOnce()
    assert.equal(report.liked, 1)
    assert.deepEqual(liked, ['a'])
    assert.equal(state.likeState('a').status, 'verified')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('PublicFeedRunner likes and records judged public feed', async () => {
    const dir = tempDir()
    const state = new JsonState(path.join(dir, 'state.json'))
    await state.load()
    const actions = []
    const feed = { cell_common: { union_id: { feed_id: 'f1' } }, content: '可爱的猫猫' }
    const qzone = {
      async requestAction(action, params) { actions.push({ action, params }); return { feeds: [feed] } },
    }
    const runner = new PublicFeedRunner({
      qzone,
      state,
      config: { enablePublicFeed: true, publicFeedLike: true, publicFeedReply: false, publicFeedMaxPerRound: 3 },
      logger: { info() {}, warn() {} },
      getModel: async () => ({ invoke: async () => ({ content: '{"like":true,"reply":""}' }) }),
      notify: async () => {},
    })
    const report = await runner.runOnce()
    assert.equal(report.checked, 1)
    assert.equal(report.liked, 1)
    assert.equal(actions[0].action, 'get_qzone_public_feeds')
    assert.equal(actions[1].action, 'set_qzone_public_like')
    assert.equal(feedKey(feed), 'f1')
    assert.equal(state.publicFeedState('f1').status, 'done')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('Config defaults keep auto-pulled model/preset fields empty', () => {
    const config = Config({})
    assert.equal(config.personaPresetId, 'foxy3')
    assert.equal(config.characterPresetId, 'foxy3')
    assert.equal(config.digestModel, '')
    assert.equal(config.publicFeedModel, '')
    assert.equal(config.enableMemeImage, false)
    assert.equal(config.enableAutoLike, false)
    assert.equal(config.enablePublicFeed, false)
  })

  await test('apply registers daily commands and root help', async () => {
    const originalStart = FoxyDailyService.prototype.start
    FoxyDailyService.prototype.start = async () => {}
    try {
      const commands = []
      const logger = () => ({ warn() {}, error() {}, info() {}, debug() {} })
      const ctx = {
        baseDir: process.cwd(),
        chatluna: null,
        inject() {},
        logger,
        on() {},
        command(name, description) {
          const command = {
            action(handler) {
              commands.push({ name, description, handler })
              return command
            },
          }
          return command
        },
      }
      apply(ctx, Config({ allowUserIds: ['u1'] }))
      assert.deepEqual(commands.map((item) => item.name.split(' ')[0]), [
        'daily',
        'daily.status',
        'daily.publish',
        'daily.comments',
        'daily.reply',
        'daily.unreplied',
        'daily.replynow',
        'daily.like',
        'daily.public',
        'daily.retry',
      ])
      const help = await commands[0].handler({ session: { userId: 'u1' } })
      assert.match(help, /daily\.publish 2026-11-03/)
      assert.match(help, /daily\.reply 1234567890 9876543210/)
      assert.doesNotMatch(help, /daily\.unreplied 示例/)
    } finally {
      FoxyDailyService.prototype.start = originalStart
    }
  })

  await test('dateKey is local-date based', () => {
    assert.equal(dateKey(new Date(2026, 0, 2, 3, 4)), '2026-01-02')
  })

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} tests passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
