'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')
const { Schema } = require('koishi')
const { JsonState } = require('./state')
const { QzoneManager } = require('./qzone')
const { CommentRunner } = require('./comments')
const { LikeRunner } = require('./likes')
const { PublicFeedRunner } = require('./public-feed')
const { buildWindow, filterMemories, generateDigest, dateKey } = require('./digest')
const { registerQzoneTools, allowed } = require('./tools')

const PLUGIN_NAME = 'foxy-daily'
const MEMORY_BACKENDS = {
  auto: '自动检测',
  livingmemory: 'LivingMemory',
  'foxy-memory': 'Foxy Memory',
}

function hasPackage(ctx, name) {
  try {
    createRequire(path.join(ctx.baseDir, 'package.json')).resolve(name)
    return true
  } catch {
    return false
  }
}

const Config = Schema.intersect([
  Schema.object({
    platform: Schema.union(['auto', 'onebot', 'milky']).description('获取 QQ 空间 Cookie 的协议').default('auto'),
    selfId: Schema.string().description('指定机器人 selfId；留空自动选择在线机器人').default(''),
    allowUserIds: Schema.array(Schema.string()).description('允许使用指令和工具的用户 QQ 号；为空时全部拒绝').default([]),
    watchUserIds: Schema.array(Schema.string()).description('额外读取动态的白名单 QQ 号（只读，用于评论检查）').default([]),
    stateFile: Schema.string().description('状态文件；相对路径基于 Koishi 数据目录').default('data/foxy-daily/state.json'),
    debug: Schema.boolean().description('输出调试日志').default(false),
  }).description('连接'),
  Schema.object({
    enableDailyDigest: Schema.boolean().description('启用每日记忆动态定时发布').default(true),
    digestTime: Schema.string().description('每日触发时间 HH:mm（服务器本地时区）').default('23:50'),
    digestMemoryLimit: Schema.number().description('单次使用的记忆条数上限').min(10).max(300).default(100),
    personaKind: Schema.union(['character', 'chatluna']).description('使用哪一套预设：character=Character 伪装插件预设，chatluna=ChatLuna 主插件预设').default('character'),
    personaPresetId: Schema.dynamic('preset').description('ChatLuna 主插件预设（来自 ChatLuna 预设列表）').default('foxy3'),
    characterPresetId: Schema.dynamic('character-preset').description('Character 伪装插件预设（来自 chatluna-character 预设列表）').default('foxy3'),
    memoryBackend: Schema.union(['auto', 'livingmemory', 'foxy-memory'])
      .description('记忆后端；auto 优先 Foxy Memory，未安装时回退 LivingMemory')
      .default('auto'),
    persona: Schema.string().description('Foxy Memory 不可用时的备用 persona').default(''),
    digestModel: Schema.dynamic('model').description('用于生成动态的 ChatLuna 模型；由 ChatLuna 自动列出').default(''),
    catchUpPreviousDay: Schema.boolean().description('凌晨 06:00 前补发前一天错过的动态').default(true),
  }).description('每日动态'),
  Schema.object({
    digestPrompt: Schema.string()
      .description('发动态提示词；留空使用内置任务说明，填写后覆盖内置任务说明')
      .default(''),
  }).description('发动态提示词'),
  Schema.object({
    enableCommentAutoReply: Schema.boolean().description('自动回复机器人自己动态下的新评论').default(true),
    commentPollIntervalMinutes: Schema.number().description('评论轮询间隔（分钟）').min(1).max(120).default(5),
    commentMaxAgeHours: Schema.number().description('只回复这个时间内的评论').min(1).max(720).default(72),
    commentMaxRepliesPerRound: Schema.number().description('每轮最多自动回复条数').min(1).max(20).default(3),
    commentMaxAttempts: Schema.number().description('单条评论最大尝试次数').min(1).max(10).default(3),
    autoReplyAllCommenters: Schema.boolean().description('自己动态下：回复所有评论者；关闭时只回复 allowUserIds 中的用户').default(true),
    replyOwnNested: Schema.boolean().description('自己动态下：也回复楼中楼（嵌套回复）').default(true),
    nestedReplyOnlyToBot: Schema.boolean().description('楼中楼只回复明确回复机器人自己的那条').default(true),
    enableOtherPostComments: Schema.boolean().description('允许评论白名单用户动态下的评论').default(false),
    otherPostCommentUserIds: Schema.array(Schema.string()).description('允许评论其动态的白名单 QQ；为空时使用 watchUserIds').default([]),
    replyOtherNested: Schema.boolean().description('别人动态下：也回复楼中楼').default(false),
    otherPostReplyAllCommenters: Schema.boolean().description('别人动态下：回复所有评论者；关闭时只回复 allowUserIds').default(true),
    monitorPostLimit: Schema.number().description('每轮检查的最近动态数').min(1).max(20).default(10),
    checkOnQzoneNotice: Schema.boolean().description('收到空间评论 notice 时立即检查（协议端需支持 qzone_comment）').default(true),
  }).description('评论'),
  Schema.object({
    enableAutoLike: Schema.boolean().description('给好友新动态自动点赞（默认关闭）').default(false),
    autoLikeIntervalMinutes: Schema.number().description('自动点赞轮询间隔（分钟）').min(1).max(120).default(10),
    autoLikeFeedLimit: Schema.number().description('每轮读取的好友动态数').min(1).max(20).default(20),
    autoLikeMaxPerRound: Schema.number().description('每轮最多点赞条数').min(1).max(10).default(5),
    autoLikeUserIds: Schema.array(Schema.string()).description('只点赞这些作者；为空表示所有好友').default([]),
    autoLikeBlockUserIds: Schema.array(Schema.string()).description('永不点赞这些作者（优先级高于白名单）').default([]),
  }).description('自动点赞'),
  Schema.object({
    enablePublicFeed: Schema.boolean().description('测试功能：空友爱看（需要 NapCat 4.18.42+，默认关闭）').default(false),
    publicFeedLike: Schema.boolean().description('遇到喜欢的内容自动点赞').default(true),
    publicFeedReply: Schema.boolean().description('遇到喜欢的内容自动评论（实验性）').default(false),
    publicFeedMaxPerRound: Schema.number().description('每轮最多处理条数').min(1).max(10).default(3),
    publicFeedModel: Schema.dynamic('model').description('判断“喜欢”用的模型；留空使用 digestModel').default(''),
    publicFeedNotifyUserId: Schema.string().description('把空友爱看互动推送到这个 QQ；留空不推送').default(''),
    publicFeedPollIntervalMinutes: Schema.number().description('空友爱看轮询间隔（分钟）').min(5).max(360).default(30),
  }).description('空友爱看（测试）'),
  Schema.object({
    toolEnabled: Schema.boolean().description('注册 ChatLuna 工具').default(true),
    characterToolEnabled: Schema.boolean().description('注册 Character reply 字段').default(true),
    enableMemeImage: Schema.boolean().description('发布动态时附带 chatlunamemes 表情包（需安装 koishi-plugin-chatluna-memes，默认关闭）').default(false),
    maxImages: Schema.number().description('单条动态最多图片数').min(0).max(9).default(9),
  }).description('工具与配图'),
])

function isAllowed(config, session) {
  return allowed(config, session)
}

function registerModelSchema(ctx) {
  try {
    const { modelSchema } = require('koishi-plugin-chatluna/utils/schema')
    if (ctx.chatluna?.platform) {
      modelSchema(ctx)
      return
    }
    ctx.inject(['chatluna'], (ctx2) => {
      try {
        modelSchema(ctx2)
      } catch (error) {
        ctx.logger?.('foxy-daily').warn(`注册模型下拉失败：${error.message}`)
      }
    })
  } catch (error) {
    ctx.logger?.('foxy-daily').warn(`ChatLuna 模型 schema 不可用：${error.message}`)
  }
}

class FoxyDailyService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.logger = ctx.logger(PLUGIN_NAME)
    this.state = new JsonState(path.isAbsolute(config.stateFile) ? config.stateFile : path.join(ctx.baseDir, config.stateFile))
    this.qzone = new QzoneManager(ctx, config, this.logger)
    this.comments = new CommentRunner({
      qzone: this.qzone,
      state: this.state,
      config,
      logger: this.logger,
      getModel: () => this.getModel(),
      getPersona: () => this.getPersona(),
    })
    this.likes = new LikeRunner({
      qzone: this.qzone,
      state: this.state,
      config,
      logger: this.logger,
    })
    this.publicFeed = new PublicFeedRunner({
      qzone: this.qzone,
      state: this.state,
      config,
      logger: this.logger,
      getModel: () => this.getModel(this.config.publicFeedModel),
      notify: (text) => this.notifyOwner(text),
    })
    this._digestRunning = false
    this._timers = []
  }

  async start() {
    this.ctx.on('ready', () => this.registerTools())
    await this.state.load()
    this._timers.push(this.ctx.setInterval(() => this.tick(), 30_000))
    if (this.config.enableCommentAutoReply) {
      const interval = Math.max(1, this.config.commentPollIntervalMinutes) * 60_000
      this._timers.push(this.ctx.setInterval(() => this.pollComments(), interval))
    }
    if (this.config.enableAutoLike) {
      const interval = Math.max(1, this.config.autoLikeIntervalMinutes) * 60_000
      this._timers.push(this.ctx.setInterval(() => this.pollLikes(), interval))
    }
    if (this.config.enablePublicFeed) {
      const interval = Math.max(5, this.config.publicFeedPollIntervalMinutes) * 60_000
      this._timers.push(this.ctx.setInterval(() => this.pollPublicFeed(), interval))
    }
    if (this.config.checkOnQzoneNotice !== false) {
      this.ctx.on('notice', (session) => this.handleQzoneNotice(session))
    }
    this.registerTools()
    this.logger.info('foxy-daily 已启动；每日动态 ' + (this.config.enableDailyDigest ? this.config.digestTime : '关闭'))
  }

  stop() {
    for (const timer of this._timers.splice(0)) {
      try {
        timer()
      } catch {}
    }
    try {
      this._disposeTools?.()
    } catch {}
  }

  registerTools() {
    if (this._toolsRegistered) return
    const hasChatluna = Boolean(this.ctx.chatluna?.platform?.registerTool)
    const hasCharacter = Boolean(this.ctx.chatluna_character?.registerReplyToolField)
    if (!hasChatluna && !hasCharacter) return
    this._toolsRegistered = true
    try {
      this._disposeTools = registerQzoneTools(this.ctx, this, this.config, this.logger)
    } catch (error) {
      this.logger.warn(`工具注册失败：${error.message}`)
    }
  }

  async getModel(modelName) {
    if (!this.ctx.chatluna?.createChatModel) throw new Error('ChatLuna 服务不可用')
    const name = modelName || this.config.digestModel
    if (!name) throw new Error('请配置 digestModel（例如 deepseek/deepseek-flash）')
    const result = await this.ctx.chatluna.createChatModel(name)
    const model = result?.value ?? result
    if (!model) throw new Error(`无法创建模型 ${name}`)
    return model
  }

  async notifyOwner(text) {
    const userId = String(this.config.publicFeedNotifyUserId || '').trim()
    if (!userId) return
    const bot = this.qzone.getSelectedBot()
    if (!bot?.sendPrivateMessage) {
      this.logger.warn('没有可用的机器人，空友爱看推送跳过')
      return
    }
    await bot.sendPrivateMessage(userId, String(text || '').slice(0, 1000))
  }

  getPresetId() {
    if (this.config.personaKind === 'chatluna') {
      return String(this.config.personaPresetId || 'foxy3').trim() || 'foxy3'
    }
    const base = String(this.config.characterPresetId || this.config.personaPresetId || 'foxy3').trim() || 'foxy3'
    if (base === '无') return 'foxy3（Character）'
    return base.endsWith('（Character）') ? base : `${base}（Character）`
  }

  async getMemeImages({ mood }) {
    const service = this.ctx.chatluna_memes
    if (!service?.getCollections) throw new Error('chatluna-memes 服务不可用')
    const collections = ((await service.getCollections()) || []).filter(Boolean)
    if (!collections.length) return []

    const keyword = String(mood || '').trim()
    const candidates = []
    for (const collection of collections.slice(0, 8)) {
      try {
        const page = await service.getCollectionResourcePage(collection, {
          search: keyword || undefined,
          limit: 20,
          type: 'all',
        })
        for (const item of page?.items || []) candidates.push({ collection, item })
      } catch (error) {
        this.logger.debug?.(`读取表情包 ${collection} 失败：${error.message}`)
      }
    }

    if (!candidates.length) {
      const collection = collections[Math.floor(Math.random() * collections.length)]
      const resource = await service.getRandomResource(collection)
      if (!resource) return []
      if (resource.type === 'local' && resource.filename) {
        const local = await service.getLocalImageBuffer(collection, resource.filename)
        return local ? [{ data: local.buffer, name: resource.filename, mimeType: local.mime }] : []
      }
      return [resource.value]
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)]
    const { collection, item } = picked
    if (item.type === 'local' && item.filename) {
      const local = await service.getLocalImageBuffer(collection, item.filename)
      return local ? [{ data: local.buffer, name: item.filename, mimeType: local.mime }] : []
    }
    return [item.value]
  }

  memoryBackendLabel() {
    const selected = this.config.memoryBackend || 'auto'
    if (selected !== 'auto') return MEMORY_BACKENDS[selected]
    if (hasPackage(this.ctx, 'koishi-plugin-chatluna-foxy-memory')) return 'Foxy Memory'
    if (hasPackage(this.ctx, 'koishi-plugin-chatluna-livingmemory')) return 'LivingMemory'
    return '未检测到记忆插件'
  }

  memoryService() {
    const selected = this.config.memoryBackend || 'auto'
    const packageName =
      selected === 'livingmemory'
        ? 'koishi-plugin-chatluna-livingmemory'
        : selected === 'foxy-memory'
          ? 'koishi-plugin-chatluna-foxy-memory'
          : ''
    if (packageName && !hasPackage(this.ctx, packageName)) {
      throw new Error(`已选择 ${MEMORY_BACKENDS[selected]}，但未安装 ${packageName}`)
    }
    const memory = this.ctx.chatluna_foxy_memory ?? this.ctx.chatluna_living_memory
    if (!memory?.listMemories) {
      throw new Error(`${this.memoryBackendLabel()} 服务不可用`)
    }
    return memory
  }

  async getPersona() {
    const memory = this.ctx.chatluna_foxy_memory ?? this.ctx.chatluna_living_memory
    const presetId = this.getPresetId()
    if (memory?.resolvePresetPersona) {
      try {
        const persona = await memory.resolvePresetPersona(presetId)
        if (persona && persona.trim()) return persona
      } catch (error) {
        this.logger.warn(`读取人设 ${presetId} 失败：${error.message}`)
      }
    }
    return this.config.persona || ''
  }

  async listMemories() {
    const memory = this.memoryService()
    const items = []
    let page = 1
    while (page <= 20) {
      const result = await memory.listMemories({
        presetId: this.getPresetId(),
        status: 'active',
        page,
        pageSize: 200,
      })
      items.push(...(result.items || []))
      if (items.length >= (result.total || 0) || !(result.items || []).length) break
      page++
    }
    return items
  }

  async getImages(content, memories, window, mood) {
    if (!this.config.enableMemeImage) return []
    try {
      const images = await this.getMemeImages({ mood })
      return (Array.isArray(images) ? images : []).slice(0, this.config.maxImages || 9)
    } catch (error) {
      this.logger.warn(`表情包配图失败：${error.message}`)
      return []
    }
  }

  async publishContent(content, images = []) {
    if (!String(content || '').trim()) throw new Error('动态内容为空')
    return this.qzone.publish(String(content).trim(), images)
  }

  async runDigest(dateOrRange, trigger = 'manual') {
    if (this._digestRunning) return { result: 'busy', detail: '已有发布任务在进行' }
    this._digestRunning = true
    let input = {}
    if (dateOrRange && typeof dateOrRange === 'object') {
      input = { from: dateOrRange.from, to: dateOrRange.to }
    } else if (typeof dateOrRange === 'string' && dateOrRange.includes('~')) {
      const [from, to] = dateOrRange.split('~')
      input = { from, to }
    } else if (dateOrRange) {
      input = { date: dateOrRange }
    }
    const window = buildWindow(input, new Date())
    try {
      const entries = await this.listMemories()
      const memories = filterMemories(entries, window.start, window.end)
      if (memories.length === 0) {
        if (trigger === 'manual') return { result: 'skipped-empty', detail: `${window.date} 没有记忆` }
        this.state.markSkipped(window.date, 'no-memories')
        await this.state.save()
        return { result: 'skipped-empty', detail: `${window.date} 没有记忆` }
      }
      const persona = await this.getPersona()
      const model = await this.getModel()
      const presetId = this.getPresetId()
      const decision = await generateDigest({
        model,
        persona,
        customPrompt: this.config.digestPrompt,
        memories,
        window,
        assistantLabel: this.config.personaKind === 'chatluna' ? this.config.personaPresetId : this.config.characterPresetId,
        presetId,
        logger: this.logger,
        debug: this.config.debug,
        agentFactory: this.agentFactory,
      })
      if (!decision.value) throw new Error(decision.error || '模型没有给出动态决策')
      if (decision.value.action === 'skip') {
        if (trigger === 'manual') return { result: 'skipped-by-model', detail: '模型认为没有值得发布的内容' }
        this.state.markSkipped(window.date, 'model-skip')
        await this.state.save()
        return { result: 'skipped-by-model', detail: '模型认为没有值得发布的内容' }
      }
      const images = await this.getImages(decision.value.content, memories, window, decision.value.mood)
      const published = await this.publishContent(decision.value.content, images)
      const record = {
        postId: published.post?.id || published.reference?.id || null,
        outcome: published.outcome,
        content: decision.value.content,
        memoryCount: memories.length,
        images: images.length,
        trigger,
      }
      if (published.outcome === 'unknown') {
        this.state.setPending({
          date: window.date,
          attempts: 1,
          nextAttemptAt: Date.now() + 5 * 60_000,
          lastError: 'unknown publish outcome; verify before retry',
          content: decision.value.content,
          unknown: true,
        })
        await this.state.save()
        return { result: 'unknown', detail: '发布结果未知，已进入待确认状态' }
      }
      this.state.markPublished(window.date, record)
      await this.state.save()
      this.logger.info(`动态发布完成 ${window.date}（${published.outcome}）`)
      return { result: 'published', record }
    } catch (error) {
      if (trigger === 'manual') throw error
      const attempts = (this.state.data.pending?.attempts || 0) + 1
      const delay = Math.min(6 * 3600_000, 5 * 60_000 * Math.pow(2, Math.min(attempts - 1, 6)))
      this.state.setPending({
        date: window.date,
        attempts,
        nextAttemptAt: Date.now() + delay,
        lastError: error.message,
      })
      await this.state.save()
      this.logger.warn(`每日动态失败（第 ${attempts} 次），${Math.round(delay / 60000)} 分钟后重试：${error.message}`)
      throw error
    } finally {
      this._digestRunning = false
    }
  }

  async tick() {
    if (!this.config.enableDailyDigest) return
    const now = new Date()
    try {
      if (this.state.data.pending) {
        const pending = this.state.data.pending
        if (pending.unknown) {
          const verified = await this.verifyUnknown(pending)
          if (verified) return
          if (Date.now() < (pending.nextAttemptAt || 0)) return
          pending.nextAttemptAt = Date.now() + 6 * 3600_000
          pending.lastError = 'unknown outcome still not visible; verify manually or retry from command'
          await this.state.save()
          this.logger.warn(`发布结果仍未确认，暂不自动重发：${pending.date}`)
          return
        }
        if (Date.now() >= (pending.nextAttemptAt || 0)) {
          try {
            await this.runDigest(pending.date, 'retry')
          } catch {}
        }
        return
      }
      const target = now.getHours() < 6 && this.config.catchUpPreviousDay
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
        : now
      const key = dateKey(target)
      if (this.state.data.published[key] || this.state.data.skipped[key]) return
      const [hour, minute] = String(this.config.digestTime || '23:50').split(':').map(Number)
      const scheduled = new Date(target.getFullYear(), target.getMonth(), target.getDate(), hour || 0, minute || 0)
      if (now.getTime() < scheduled.getTime()) return
      try {
        await this.runDigest(key, 'scheduled')
      } catch {}
    } catch (error) {
      this.logger.warn(`调度检查失败：${error.message}`)
    }
  }

  async verifyUnknown(pending) {
    try {
      const page = await this.qzone.listSelfFeeds(20)
      const found = page.items.find((post) => String(post.content || '').trim() === String(pending.content || '').trim())
      if (found) {
        this.state.markPublished(pending.date, { postId: found.id, outcome: 'verified', content: pending.content, trigger: 'verify' })
        await this.state.save()
        this.logger.info(`确认未知结果实际已发布：${pending.date} / ${found.id}`)
        return true
      }
    } catch (error) {
      this.logger.warn(`确认发布结果失败：${error.message}`)
    }
    return false
  }

  async pollComments() {
    try {
      const report = await this.comments.runOnce()
      if (this.config.debug && (report.replied || report.checked)) {
        this.logger.debug(`评论检查：checked=${report.checked} replied=${report.replied}`)
      }
      return report
    } catch (error) {
      this.logger.warn(`评论轮询失败：${error.message}`)
      return { checked: 0, replied: 0, skipped: 0, error: error.message }
    }
  }

  async pollLikes() {
    try {
      const report = await this.likes.runOnce()
      if (this.config.debug && (report.checked || report.liked)) {
        this.logger.debug(`自动点赞：checked=${report.checked} liked=${report.liked}`)
      }
      return report
    } catch (error) {
      this.logger.warn(`自动点赞失败：${error.message}`)
      return { checked: 0, liked: 0, skipped: 0, error: error.message }
    }
  }

  async pollPublicFeed() {
    try {
      const report = await this.publicFeed.runOnce()
      if (this.config.debug && (report.checked || report.liked || report.replied)) {
        this.logger.debug(`空友爱看：checked=${report.checked} liked=${report.liked} replied=${report.replied}`)
      }
      return report
    } catch (error) {
      this.logger.warn(`空友爱看失败：${error.message}`)
      return { checked: 0, liked: 0, replied: 0, skipped: 0, error: error.message }
    }
  }

  handleQzoneNotice(session) {
    const event = session?.event || {}
    const raw = JSON.stringify(event)
    const type = String(event.noticeType || event.notice_type || event.type || '')
    if (!/qzone/i.test(type) && !/"qzone/i.test(raw)) return
    if (!/comment|reply|空间/i.test(raw)) return
    this.logger.debug('收到空间评论 notice，立即检查评论')
    this.pollComments().catch(() => {})
  }

  async listUnreplied() {
    return this.comments.listUnreplied()
  }

  async replyNow() {
    return this.comments.runOnce()
  }

  async handleTool(action, input, session) {
    if (!isAllowed(this.config, session)) throw new Error('当前用户没有使用 Foxy 动态工具的权限')
    if (action === 'publish') {
      if (input.content) {
        const result = await this.publishContent(input.content, [])
        return `发布结果：${result.outcome}${result.post?.id ? `，动态 ${result.post.id}` : ''}`
      }
      const result = await this.runDigest(input.date, 'tool')
      if (result.result === 'published') return `已发布动态 ${result.record.postId || ''}`
      return `未发布：${result.detail || result.result}`
    }
    if (action === 'comments') {
      return await this.comments.listComments(input.post_id)
    }
    if (action === 'reply') {
      const result = await this.comments.replyManual(input.post_id, input.comment_id, input.content)
      return `回复结果：${result.outcome}`
    }
    throw new Error(`未知操作：${action}`)
  }

  statusText() {
    const pending = this.state.data.pending
    const last = this.state.data.lastRun
    const presetLabel =
      this.config.personaKind === 'chatluna'
        ? `${this.config.personaPresetId || 'foxy3'}（chatluna）`
        : `${this.config.characterPresetId || this.config.personaPresetId || 'foxy3'}（character）`
    return [
      `每日动态：${this.config.enableDailyDigest ? `开启，${this.config.digestTime}` : '关闭'}`,
      `评论自动回复：${this.config.enableCommentAutoReply ? `开启，每 ${this.config.commentPollIntervalMinutes} 分钟` : '关闭'}`,
      `自动点赞：${this.config.enableAutoLike ? `开启，每 ${this.config.autoLikeIntervalMinutes} 分钟` : '关闭'}`,
      `空友爱看：${this.config.enablePublicFeed ? '开启（测试）' : '关闭'}`,
      `预设：${presetLabel}；记忆 presetId：${this.getPresetId()}`,
      `QQ 空间：${JSON.stringify(this.qzone.status())}`,
      pending ? `待重试：${pending.date}，第 ${pending.attempts} 次，${new Date(pending.nextAttemptAt).toLocaleString('zh-CN')}，${pending.lastError || ''}` : '待重试：无',
      last ? `最近：${last.date} / ${last.result}${last.detail ? ` / ${last.detail}` : ''}` : '最近：无',
    ].join('\n')
  }
}

function apply(ctx, config) {
  registerModelSchema(ctx)

  const service = new FoxyDailyService(ctx, config)
  ctx.foxyDaily = service
  ctx.on('dispose', () => service.stop())

  const help = [
    'Foxy 每日动态命令：',
    'daily.status — 查看状态、待重试任务、QQ 空间登录态',
    'daily.publish [from] [to] — 手动发布单日或日期区间',
    '  示例：daily.publish 2026-11-03',
    '  示例：daily.publish 2026-11-01 2026-11-03',
    'daily.comments [postId] — 读取评论；不填 postId 读取最近动态',
    '  示例：daily.comments 1234567890',
    'daily.reply <postId> <commentId> <content> — 手动回复评论',
    '  示例：daily.reply 1234567890 9876543210 谢谢你的评论',
    'daily.unreplied — 列出尚未回复的评论',
    'daily.replynow — 立即读取并回复一轮',
    'daily.like — 立即给好友新动态点赞',
    'daily.public — 立即读取空友爱看',
    'daily.retry — 立即重试待发布的动态',
  ].join('\n')

  ctx.command('daily', 'Foxy 每日动态命令列表').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    return help
  })

  ctx.command('daily.status', '查看 Foxy 每日动态状态').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    return service.statusText()
  })

  ctx.command('daily.publish [from:string] [to:string]', '手动发布每日动态；可指定日期或日期区间').action(async ({ session }, from, to) => {
    if (!isAllowed(config, session)) return '没有权限'
    const input = to ? { from, to } : from || undefined
    const result = await service.runDigest(input, 'manual')
    if (result.result === 'published') return `已发布 ${result.record.postId || ''}（${result.record.outcome}）`
    return `未发布：${result.detail || result.result}`
  })

  ctx.command('daily.comments [postId:string]', '读取机器人动态下的评论').action(async ({ session }, postId) => {
    if (!isAllowed(config, session)) return '没有权限'
    return await service.comments.listComments(postId || undefined)
  })

  ctx.command('daily.reply <postId:string> <commentId:string> <content:text>', '回复一条评论').action(
    async ({ session }, postId, commentId, content) => {
      if (!isAllowed(config, session)) return '没有权限'
      if (!content || !content.trim()) return '回复内容不能为空'
      const result = await service.comments.replyManual(postId, commentId, content.trim())
      return `已回复（${result.outcome}）`
    },
  )

  ctx.command('daily.unreplied', '列出机器人动态下尚未回复的评论').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    return await service.listUnreplied()
  })

  ctx.command('daily.replynow', '立即读取并回复一轮未回复评论').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    const report = await service.replyNow()
    return `已检查 ${report.checked} 条，回复 ${report.replied} 条，跳过 ${report.skipped} 条`
  })

  ctx.command('daily.like', '立即给好友新动态点赞（需开启 enableAutoLike）').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    if (!config.enableAutoLike) return '自动点赞未开启（enableAutoLike）'
    const report = await service.pollLikes()
    return `已检查 ${report.checked} 条，点赞 ${report.liked} 条，跳过 ${report.skipped} 条`
  })

  ctx.command('daily.public', '立即读取空友爱看（需开启 enablePublicFeed）').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    if (!config.enablePublicFeed) return '空友爱看未开启（enablePublicFeed）'
    const report = await service.pollPublicFeed()
    return `已检查 ${report.checked} 条，点赞 ${report.liked} 条，评论 ${report.replied} 条，跳过 ${report.skipped} 条`
  })

  ctx.command('daily.retry', '立即重试待发布的动态').action(async ({ session }) => {
    if (!isAllowed(config, session)) return '没有权限'
    const pending = service.state.data.pending
    if (!pending) return '没有待重试任务'
    const result = await service.runDigest(pending.date, 'manual')
    return result.result === 'published' ? `已补发 ${result.record.postId || ''}` : `未发布：${result.detail || result.result}`
  })

  service.start().catch((error) => ctx.logger.error(`foxy-daily 启动失败：${error.message}`))
}

module.exports = {
  name: PLUGIN_NAME,
  Config,
  apply,
  FoxyDailyService,
  buildWindow,
  filterMemories,
}
