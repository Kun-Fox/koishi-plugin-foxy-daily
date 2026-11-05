'use strict'

const { QzoneClient, QzoneAuthError, QzoneNotFoundError, QzoneRateLimitError } = require('qzone-sdk')

const COOKIE_DOMAINS = ['user.qzone.qq.com', 'qzone.qq.com', 'h5.qzone.qq.com', 'mobile.qzone.qq.com']
const UIN_KEYS = ['uin', 'p_uin', 'p_uins', 'ptui_loginuin', 'luin']

function parseCookieHeader(header) {
  const jar = {}
  for (const segment of String(header || '').split(';')) {
    const index = segment.indexOf('=')
    if (index <= 0) continue
    const key = segment.slice(0, index).trim()
    const value = segment.slice(index + 1).trim()
    if (key) jar[key] = value
  }
  return jar
}

function extractUin(jar) {
  for (const key of UIN_KEYS) {
    const raw = jar[key]
    if (!raw) continue
    const value = String(raw).replace(/^o/, '').replace(/[^\d]/g, '')
    if (/^\d{5,12}$/.test(value)) return value
  }
  return null
}

function hasQzoneTicket(jar) {
  return Boolean(jar.p_skey || jar.skey || jar.skey2)
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data)
  return null
}

async function normalizeImage(image, index) {
  if (!image) return null
  if (typeof image === 'string' || image instanceof URL) {
    const url = String(image)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`下载配图失败 ${response.status}: ${url}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      data: new Uint8Array(buffer),
      name: `foxy-daily-${Date.now()}-${index}.${(response.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg'}`,
      mimeType: response.headers.get('content-type') || 'image/jpeg',
    }
  }
  if (typeof image === 'object') {
    const data = toUint8Array(image.data ?? image.buffer ?? image)
    if (data) {
      return {
        data,
        name: image.name || `foxy-daily-${Date.now()}-${index}.jpg`,
        mimeType: image.mimeType || image.mime || 'image/jpeg',
      }
    }
    if (image.url) return normalizeImage(image.url, index)
  }
  throw new Error(`不支持的配图格式（第 ${index + 1} 张）`)
}

async function normalizeImages(images) {
  const output = []
  for (let i = 0; i < (images || []).length; i++) {
    const image = await normalizeImage(images[i], i)
    if (image) output.push(image)
  }
  return output
}

function cookiePlatformLabel(platform) {
  return platform === 'milky' ? 'Milky' : 'OneBot'
}

function selectBot(ctx, platform, selfId) {
  const order = platform === 'auto' ? ['onebot', 'milky'] : [platform]
  for (const name of order) {
    const bot = ctx.bots.find((candidate) => {
      if (candidate.platform !== name) return false
      if (selfId && candidate.selfId !== selfId) return false
      return candidate.status === 1
    })
    if (bot) return bot
  }
  return undefined
}

async function getCookieHeader(bot, domain) {
  if (bot.platform === 'milky') {
    const result = await bot.internal.getCookies(domain)
    return result && typeof result === 'object' ? result.cookies : result
  }
  return bot.internal.getCookies(domain)
}

async function getLoginUin(bot) {
  try {
    const info = await bot.internal.getLoginInfo()
    const raw = info && (info.user_id || info.uin)
    const value = String(raw || '').replace(/[^\d]/g, '')
    return /^\d{5,12}$/.test(value) ? value : null
  } catch {
    return null
  }
}

async function acquireCookies(bot) {
  const failures = []
  let loginUin = null
  let loginUinResolved = false
  for (const domain of COOKIE_DOMAINS) {
    let header
    try {
      header = await getCookieHeader(bot, domain)
    } catch (error) {
      failures.push(`${domain}: ${error.message}`)
      continue
    }
    const jar = parseCookieHeader(header)
    if (!hasQzoneTicket(jar)) {
      failures.push(`${domain}: Cookie 缺少 p_skey/skey/skey2`)
      continue
    }
    let accountId = extractUin(jar)
    if (!accountId && !loginUinResolved) {
      loginUin = await getLoginUin(bot)
      loginUinResolved = true
    }
    if (!accountId) accountId = loginUin
    if (accountId) return { cookies: String(header), accountId, domain }
    failures.push(`${domain}: 无法识别 QQ 号`)
  }
  throw new Error(`无法从 ${cookiePlatformLabel(bot.platform)} 获取 QQ 空间 Cookie：${failures.join('；')}`)
}

class QzoneManager {
  constructor(ctx, config, logger) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.client = null
    this.accountId = null
    this._acquiring = null
  }

  async getClient() {
    if (this.client) return this.client
    if (this._acquiring) return this._acquiring
    this._acquiring = this._createClient().finally(() => {
      this._acquiring = null
    })
    return this._acquiring
  }

  async _createClient() {
    const bot = selectBot(this.ctx, this.config.platform, this.config.selfId)
    if (!bot) {
      throw new Error('没有在线的 OneBot/Milky 机器人；检查 platform/selfId 配置和协议端状态')
    }
    const grant = await acquireCookies(bot)
    this.accountId = grant.accountId
    this.logger.info(`QQ 空间登录态来自 ${cookiePlatformLabel(bot.platform)} ${bot.selfId}，账号 ${grant.accountId}`)
    this.client = new QzoneClient({
      session: { cookies: grant.cookies, accountId: grant.accountId },
      logger: (event) => {
        if (this.config.debug && event.level !== 'debug') {
          this.logger.debug(`qzone-sdk ${event.phase}${event.errorCode ? ` ${event.errorCode}` : ''}`)
        }
      },
    })
    return this.client
  }

  async reset() {
    if (this.client) {
      try {
        await this.client.close?.()
      } catch {}
    }
    this.client = null
    this.accountId = null
  }

  async withClient(fn) {
    const client = await this.getClient()
    try {
      return await fn(client)
    } catch (error) {
      if (error instanceof QzoneAuthError) {
        await this.reset()
      }
      throw error
    }
  }

  async listSelfFeeds(limit = 10) {
    return this.withClient((client) => client.listFeeds({ scope: 'self', limit }))
  }

  async listUserFeeds(userId, limit = 10) {
    return this.withClient((client) => client.listFeeds({ scope: 'profile', userId: String(userId), limit }))
  }

  async listFriendsFeeds(limit = 10) {
    return this.withClient((client) => client.listFeeds({ scope: 'friends', limit }))
  }

  async like(post) {
    return this.withClient((client) => client.like({ post }))
  }

  async unlike(post) {
    return this.withClient((client) => client.unlike({ post }))
  }

  getSelectedBot() {
    return selectBot(this.ctx, this.config.platform, this.config.selfId)
  }

  /**
   * 调用协议端扩展 action（例如 NapCat 的空友爱看）。
   * 不同协议端的返回包装略有差异，这里只负责把 data 取出来。
   */
  async requestAction(action, params = {}) {
    const bot = this.getSelectedBot()
    if (!bot?.internal?._request) {
      throw new Error(`当前协议端不支持 ${action}；需要支持该扩展 action 的 OneBot 实现`)
    }
    const response = await bot.internal._request(action, params)
    if (!response || response.status === 'failed' || (response.retcode != null && response.retcode !== 0)) {
      const message = response?.message || response?.wording || response?.data?.message || '协议端返回失败'
      throw new Error(`${action} 失败：${message}`)
    }
    return response.data ?? response
  }

  async getPost(post) {
    return this.withClient((client) => client.getPost({ post }))
  }

  async publish(content, images) {
    const normalized = await normalizeImages(images)
    return this.withClient((client) => client.publishPost({ content, images: normalized }))
  }

  async comment(post, content) {
    return this.withClient((client) => client.comment({ post, content }))
  }

  async reply(post, comment, content) {
    return this.withClient((client) => client.reply({ post, comment, content }))
  }

  async findOwnPost(postId) {
    const page = await this.listSelfFeeds(20)
    const found = page.items.find((item) => String(item.id) === String(postId))
    if (!found) throw new QzoneNotFoundError(`未在机器人自己的动态中找到 ${postId}`)
    return found
  }

  status() {
    return {
      platform: this.config.platform,
      selfId: this.config.selfId || null,
      accountId: this.accountId,
      initialized: Boolean(this.client),
    }
  }
}

module.exports = {
  QzoneManager,
  acquireCookies,
  parseCookieHeader,
  extractUin,
  hasQzoneTicket,
  normalizeImages,
  selectBot,
  QzoneAuthError,
  QzoneNotFoundError,
  QzoneRateLimitError,
}
