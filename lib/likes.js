'use strict'

function normalizeIds(values) {
  return (values || []).map(String).filter(Boolean)
}

class LikeRunner {
  constructor(options) {
    this.qzone = options.qzone
    this.state = options.state
    this.config = options.config
    this.logger = options.logger
    this._running = false
  }

  _allowed(post) {
    if (!post || !post.authorId) return false
    const self = this.qzone.accountId
    if (self && String(post.authorId) === String(self)) return false
    const blacklist = normalizeIds(this.config.autoLikeBlockUserIds)
    if (blacklist.includes(String(post.authorId))) return false
    const whitelist = normalizeIds(this.config.autoLikeUserIds)
    if (whitelist.length > 0 && !whitelist.includes(String(post.authorId))) return false
    return true
  }

  async runOnce() {
    if (this._running || !this.config.enableAutoLike) return { checked: 0, liked: 0, skipped: 0 }
    this._running = true
    const report = { checked: 0, liked: 0, skipped: 0 }
    try {
      const page = await this.qzone.listFriendsFeeds(this.config.autoLikeFeedLimit || 20)
      let writes = 0
      for (const post of page.items || []) {
        report.checked++
        if (!this._allowed(post)) {
          report.skipped++
          continue
        }
        if (this.state.likeState(post.id)) {
          report.skipped++
          continue
        }
        if (writes >= (this.config.autoLikeMaxPerRound || 5)) break
        try {
          const result = await this.qzone.like(post)
          this.state.setLikeState(post.id, {
            status: result.outcome,
            authorId: post.authorId,
          })
          await this.state.save()
          writes++
          report.liked++
          this.logger.info(`已点赞动态 ${post.id}（${result.outcome}）`)
        } catch (error) {
          this.state.setLikeState(post.id, { status: 'failed', error: error.message })
          await this.state.save()
          this.logger.warn(`点赞动态 ${post.id} 失败：${error.message}`)
          report.skipped++
        }
      }
      return report
    } finally {
      this._running = false
    }
  }
}

module.exports = { LikeRunner }
