'use strict'

const { createHash } = require('node:crypto')
const { generateReply } = require('./digest')

function formatAuthor(comment) {
  return comment.author?.nickname || comment.author?.id || '未知'
}

function flattenComments(post) {
  return Array.isArray(post.comments) ? post.comments : []
}

function commentKey(comment) {
  const id = String(comment?.id || '')
  const kind = String(comment?.kind || 'comment')
  const target = String(comment?.replyTo?.id ?? comment?.replyToUser?.id ?? comment?.parentId ?? '')
  const author = String(comment?.author?.id || '')
  const content = String(comment?.content || '')
  const hash = createHash('sha1').update(content).digest('hex').slice(0, 10)
  return `${id}:${kind}:${target}:${author}:${hash}`
}

function findComment(post, commentId) {
  const value = String(commentId)
  return flattenComments(post).find(
    (comment) => commentKey(comment) === value || String(comment.id) === value,
  )
}

function normalizeIds(values) {
  return (values || []).map(String).filter(Boolean)
}

class CommentRunner {
  constructor(options) {
    this.qzone = options.qzone
    this.state = options.state
    this.config = options.config
    this.logger = options.logger
    this.getModel = options.getModel
    this.getPersona = options.getPersona
    this._running = false
  }

  get accountId() {
    return this.qzone.accountId
  }

  _isOwnPost(post) {
    return Boolean(this.accountId && String(post.authorId) === String(this.accountId))
  }

  _readUserIds() {
    return [...new Set([
      ...normalizeIds(this.config.watchUserIds),
      ...normalizeIds(this.config.otherPostCommentUserIds),
    ])]
  }

  _otherPostAllowed(post) {
    if (!this.config.enableOtherPostComments) return false
    const ids = normalizeIds(this.config.otherPostCommentUserIds)
    const list = ids.length > 0 ? ids : normalizeIds(this.config.watchUserIds)
    return list.length > 0 && list.includes(String(post.authorId))
  }

  _nestedAllowed(post, comment) {
    if (comment.kind !== 'reply') return true
    const enabled = this._isOwnPost(post)
      ? this.config.replyOwnNested !== false
      : this.config.replyOtherNested === true
    if (!enabled) return false
    if (this.config.nestedReplyOnlyToBot !== false) {
      const target = comment.replyTo?.id ?? comment.replyToUser?.id
      if (!target || String(target) !== String(this.accountId)) return false
    }
    return true
  }

  _commentAllowed(post, comment) {
    if (!comment || (comment.kind !== 'comment' && comment.kind !== 'reply')) return false
    if (this.accountId && String(comment.author?.id) === String(this.accountId)) return false
    if (this._isOwnPost(post)) {
      if (!this._nestedAllowed(post, comment)) return false
      return true
    }
    if (!this._otherPostAllowed(post)) return false
    return this._nestedAllowed(post, comment)
  }

  _commenterAllowed(post, comment) {
    const allowedIds = normalizeIds(this.config.allowUserIds)
    const all = this._isOwnPost(post)
      ? this.config.autoReplyAllCommenters !== false
      : this.config.otherPostReplyAllCommenters !== false
    if (all) return true
    return allowedIds.includes(String(comment.author?.id))
  }

  async _findPost(postId) {
    try {
      return await this.qzone.findOwnPost(postId)
    } catch {}

    for (const userId of this._readUserIds()) {
      try {
        const page = await this.qzone.listUserFeeds(userId, 20)
        const found = (page.items || []).find((item) => String(item.id) === String(postId))
        if (found) return found
      } catch (error) {
        this.logger.warn(`读取白名单 ${userId} 的动态失败：${error.message}`)
      }
    }
    throw new Error(`找不到动态 ${postId}；只检查自己的动态和白名单用户的动态`)
  }

  async _targets(postId) {
    if (postId) return [await this._findPost(postId)]

    const page = await this.qzone.listSelfFeeds(this.config.monitorPostLimit || 10)
    const posts = [...page.items]
    const seen = new Set(posts.map((post) => String(post.id)))

    for (const userId of this._readUserIds()) {
      try {
        const other = await this.qzone.listUserFeeds(userId, Math.min(5, this.config.monitorPostLimit || 10))
        for (const post of other.items || []) {
          if (seen.has(String(post.id))) continue
          seen.add(String(post.id))
          posts.push(post)
        }
      } catch (error) {
        this.logger.warn(`读取白名单 ${userId} 的动态失败：${error.message}`)
      }
    }
    return posts
  }

  _commentState(post, comment, comments = flattenComments(post)) {
    const stableKey = commentKey(comment)
    const direct = this.state.commentState(post.id, stableKey)
    if (direct) return direct
    const legacy = this.state.commentState(post.id, String(comment.id))
    if (!legacy) return undefined
    const siblings = comments.filter((item) => String(item.id) === String(comment.id))
    const nonSelf = this.accountId
      ? siblings.filter((item) => String(item.author?.id) !== String(this.accountId))
      : siblings
    if (nonSelf.length <= 1) return nonSelf[0] === comment ? legacy : undefined
    // Qzone can reuse a raw comment id for a root comment and a nested reply.
    // Legacy state has only the raw id; prefer the user's reply sibling because
    // old flows usually consumed the nested reply first. Never assign legacy
    // state to Foxy's own reply, which can share the same id.
    const replySibling = nonSelf.find((item) => item.kind === 'reply')
    if (replySibling) return replySibling === comment ? legacy : undefined
    return nonSelf[0] === comment ? legacy : undefined
  }

  async listComments(postId) {
    const posts = await this._targets(postId)
    const lines = []
    for (const summary of posts) {
      const post = await this.qzone.getPost(summary)
      const own = this._isOwnPost(post)
      lines.push(`动态 ${post.id}${own ? '（自己）' : `（${formatAuthor({ author: post.author })}）`}：${String(post.content || '').replace(/\s+/g, ' ').slice(0, 80)}`)
      const comments = flattenComments(post)
      if (comments.length === 0) lines.push('  （无评论）')
      for (const comment of comments) {
        const state = this._commentState(post, comment, comments)
        const mark = state?.status === 'replied' ? '已回复' : state?.status === 'unknown' ? '待确认' : '未回复'
        const nested = comment.kind === 'reply'
          ? `，回复 ${comment.replyToUser?.nickname || comment.replyTo?.id || '?'}`
          : ''
        lines.push(`  [${comment.id}] ${formatAuthor(comment)}（${comment.kind}${nested}，${mark}）：${String(comment.content || '').replace(/\s+/g, ' ')}`)
      }
    }
    return lines.join('\n')
  }

  async listUnreplied() {
    const posts = await this._targets()
    const lines = []
    for (const summary of posts) {
      const post = await this.qzone.getPost(summary)
      if (!this._isOwnPost(post) && !this._otherPostAllowed(post)) continue
      const pending = []
      const comments = flattenComments(post)
      for (const comment of comments) {
        if (!this._commentAllowed(post, comment)) continue
        if (!this._commenterAllowed(post, comment)) continue
        const existing = this._commentState(post, comment, comments)
        if (existing && ['replied', 'processing', 'unknown', 'skipped'].includes(existing.status)) continue
        if ((existing?.attempts || 0) >= (this.config.commentMaxAttempts || 3)) continue
        const ageMs = comment.createdAt ? Date.now() - new Date(comment.createdAt).getTime() : 0
        if (ageMs > (this.config.commentMaxAgeHours || 72) * 3600_000) continue
        pending.push(comment)
      }
      if (pending.length === 0) continue
      lines.push(`动态 ${post.id}${this._isOwnPost(post) ? '（自己）' : `（${formatAuthor({ author: post.author })}）`}：${String(post.content || '').replace(/\s+/g, ' ').slice(0, 80)}`)
      for (const comment of pending) {
        const nested = comment.kind === 'reply'
          ? `，回复 ${comment.replyToUser?.nickname || comment.replyTo?.id || '?'}`
          : ''
        lines.push(`  [${comment.id}] ${formatAuthor(comment)}（${comment.kind}${nested}）：${String(comment.content || '').replace(/\s+/g, ' ')}`)
      }
    }
    return lines.length > 0 ? lines.join('\n') : '没有发现未回复的评论。'
  }

  async replyManual(postId, commentId, content) {
    const summary = await this._findPost(postId)
    const post = await this.qzone.getPost(summary)
    const comment = findComment(post, commentId)
    if (!comment) throw new Error(`动态 ${postId} 下找不到评论 ${commentId}`)
    if (!this._commentAllowed(post, comment)) throw new Error('这条评论不在允许回复的范围内')
    const key = commentKey(comment)
    const result = await this.qzone.reply(post, comment, content)
    this.state.setCommentState(post.id, key, {
      status: result.outcome === 'unknown' ? 'unknown' : 'replied',
      outcome: result.outcome,
      reply: content,
      manual: true,
    })
    await this.state.save()
    return result
  }

  async _reply(post, comment) {
    const key = commentKey(comment)
    const existing = this._commentState(post, comment)
    this.state.setCommentState(post.id, key, {
      status: 'processing',
      attempts: (existing?.attempts || 0) + 1,
    })
    await this.state.save()
    const model = await this.getModel()
    const persona = await this.getPersona()
    const content = await generateReply({ model, post, comment, persona })
    if (!content) {
      this.state.setCommentState(post.id, key, {
        status: 'failed',
        attempts: (existing?.attempts || 0) + 1,
        error: 'empty reply',
      })
      await this.state.save()
      return { replied: false, reason: 'empty' }
    }
    const result = await this.qzone.reply(post, comment, content)
    this.state.setCommentState(post.id, key, {
      status: result.outcome === 'unknown' ? 'unknown' : 'replied',
      outcome: result.outcome,
      reply: content,
    })
    await this.state.save()
    this.logger.info(`已回复动态 ${post.id} 评论 ${comment.id}（${result.outcome}）`)
    return { replied: true, content, outcome: result.outcome }
  }

  async runOnce() {
    if (this._running || !this.config.enableCommentAutoReply) {
      return { checked: 0, replied: 0, skipped: 0 }
    }
    this._running = true
    const report = { checked: 0, replied: 0, skipped: 0 }
    try {
      const posts = await this._targets()
      let writes = 0
      for (const summary of posts) {
        const post = await this.qzone.getPost(summary)
        if (!this._isOwnPost(post) && !this._otherPostAllowed(post)) continue
        const comments = flattenComments(post)
        for (const comment of comments) {
          if (!this._commentAllowed(post, comment)) continue
          if (!this._commenterAllowed(post, comment)) {
            report.skipped++
            continue
          }
          const existing = this._commentState(post, comment, comments)
          if (existing && ['replied', 'processing', 'unknown', 'skipped'].includes(existing.status)) continue
          if ((existing?.attempts || 0) >= (this.config.commentMaxAttempts || 3)) continue
          const ageMs = comment.createdAt ? Date.now() - new Date(comment.createdAt).getTime() : 0
          if (ageMs > (this.config.commentMaxAgeHours || 72) * 3600_000) {
            this.state.setCommentState(post.id, commentKey(comment), { status: 'skipped', reason: 'too-old' })
            await this.state.save()
            report.skipped++
            continue
          }
          if (writes >= (this.config.commentMaxRepliesPerRound || 3)) break
          report.checked++
          try {
            const result = await this._reply(post, comment)
            if (result.replied) {
              writes++
              report.replied++
            } else {
              report.skipped++
            }
          } catch (error) {
            this.state.setCommentState(post.id, commentKey(comment), {
              status: 'failed',
              attempts: (existing?.attempts || 0) + 1,
              error: error.message,
            })
            await this.state.save()
            this.logger.warn(`回复动态 ${post.id} 评论 ${comment.id} 失败：${error.message}`)
          }
        }
      }
      return report
    } finally {
      this._running = false
    }
  }
}

module.exports = { CommentRunner, commentKey, flattenComments, findComment }
