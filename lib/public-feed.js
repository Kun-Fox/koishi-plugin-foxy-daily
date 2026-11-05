'use strict'

const crypto = require('node:crypto')
const { SystemMessage, HumanMessage } = require('@langchain/core/messages')

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function collectText(value, output, depth = 0) {
  if (depth > 6 || output.length > 40) return
  if (typeof value === 'string') {
    const text = normalizeText(value)
    if (text.length >= 2 && text.length <= 300) output.push(text)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(content|text|title|summary|desc|description|nick|name)$/i.test(key)) {
        collectText(item, output, depth + 1)
      } else if (depth < 3) {
        collectText(item, output, depth + 1)
      }
    }
  }
}

function feedText(feed) {
  const parts = []
  collectText(feed, parts)
  return [...new Set(parts)].join(' / ').slice(0, 2000)
}

function feedKey(feed) {
  const union = feed?.cell_common?.union_id
  const id = union?.feed_id || union?.ugc_id || union?.uf_key
  if (id) return String(id)
  return crypto.createHash('sha1').update(JSON.stringify(feed)).digest('hex')
}

class PublicFeedRunner {
  constructor(options) {
    this.qzone = options.qzone
    this.state = options.state
    this.config = options.config
    this.logger = options.logger
    this.getModel = options.getModel
    this.notify = options.notify
    this._running = false
  }

  async _judge(text) {
    if (!this.config.publicFeedLike && !this.config.publicFeedReply) return { like: false, reply: '' }
    const model = await this.getModel()
    const prompt = [
      '你在浏览 QQ 空间的“空友爱看”公开推荐动态。',
      '判断你是否喜欢这条内容；只有确实有趣、可爱、值得互动时才喜欢。',
      '回复必须短、自然、像真人，不能暴露 AI 身份。',
      '只输出 JSON，不要 Markdown：{"like":true|false,"reply":"..."}；不想回复时 reply 为空字符串。',
      `动态内容：${text || '（无文本）'}`,
    ].join('\n')
    const result = await model.invoke([
      new SystemMessage('你是一个有明确喜好、但不随便刷存在的 QQ 空间用户。'),
      new HumanMessage(prompt),
    ])
    const content = typeof result?.content === 'string'
      ? result.content
      : Array.isArray(result?.content)
        ? result.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
        : ''
    const match = /\{[\s\S]*\}/.exec(content)
    if (!match) return { like: false, reply: '' }
    try {
      const parsed = JSON.parse(match[0])
      return {
        like: parsed.like === true,
        reply: typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 300) : '',
      }
    } catch {
      return { like: false, reply: '' }
    }
  }

  async runOnce() {
    if (this._running || !this.config.enablePublicFeed) {
      return { checked: 0, liked: 0, replied: 0, skipped: 0, disabled: !this.config.enablePublicFeed }
    }
    this._running = true
    const report = { checked: 0, liked: 0, replied: 0, skipped: 0 }
    try {
      const data = await this.qzone.requestAction('get_qzone_public_feeds', {})
      const feeds = Array.isArray(data?.feeds) ? data.feeds : Array.isArray(data?.data?.feeds) ? data.data.feeds : []
      let writes = 0
      for (const feed of feeds) {
        report.checked++
        if (writes >= (this.config.publicFeedMaxPerRound || 3)) break
        const key = feedKey(feed)
        if (this.state.publicFeedState(key)) {
          report.skipped++
          continue
        }
        const text = feedText(feed)
        try {
          const decision = await this._judge(text)
          if (!decision.like && !decision.reply) {
            this.state.setPublicFeedState(key, { status: 'skipped', reason: 'not-interested', text })
            await this.state.save()
            report.skipped++
            continue
          }
          if (decision.like && this.config.publicFeedLike !== false) {
            await this.qzone.requestAction('set_qzone_public_like', { feed, enable: true })
            report.liked++
          }
          if (decision.reply && this.config.publicFeedReply) {
            await this.qzone.requestAction('comment_qzone_public_feed', { feed, content: decision.reply })
            report.replied++
          }
          this.state.setPublicFeedState(key, {
            status: 'done',
            liked: Boolean(decision.like),
            replied: Boolean(decision.reply),
            text,
          })
          await this.state.save()
          writes++
          if (this.notify && (decision.like || decision.reply)) {
            try {
              await this.notify(`空友爱看：${decision.like ? '点赞' : ''}${decision.reply ? ' 回复' : ''}\n${text.slice(0, 200)}`)
            } catch (error) {
              this.logger.warn(`空友爱看推送失败：${error.message}`)
            }
          }
        } catch (error) {
          this.state.setPublicFeedState(key, { status: 'failed', error: error.message, text })
          await this.state.save()
          this.logger.warn(`空友爱看处理失败：${error.message}`)
          report.skipped++
        }
      }
      return report
    } catch (error) {
      this.logger.warn(`空友爱看读取失败（检查 NapCat 版本/接口）：${error.message}`)
      return { ...report, error: error.message }
    } finally {
      this._running = false
    }
  }
}

module.exports = { PublicFeedRunner, feedKey, feedText }
