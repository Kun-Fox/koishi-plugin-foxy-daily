'use strict'

const fs = require('node:fs')
const path = require('node:path')

function emptyState() {
  return {
    version: 1,
    published: {},
    skipped: {},
    pending: null,
    comments: {},
    likes: {},
    publicFeeds: {},
    lastRun: null,
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

class JsonState {
  constructor(file) {
    this.file = file
    this.data = emptyState()
    this._writing = Promise.resolve()
  }

  async load() {
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = Object.assign(emptyState(), parsed || {})
      for (const key of ['published', 'skipped', 'comments', 'likes', 'publicFeeds']) {
        if (!this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) {
          this.data[key] = {}
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.data = emptyState()
    }
    return this.data
  }

  snapshot() {
    return clone(this.data)
  }

  get(publishedKey) {
    return this.data[publishedKey]
  }

  async save() {
    const next = this._writing.then(async () => {
      const dir = path.dirname(this.file)
      await fs.promises.mkdir(dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await fs.promises.rename(tmp, this.file)
    })
    this._writing = next.catch(() => {})
    return next
  }

  markPublished(date, record) {
    this.data.published[date] = Object.assign({ at: new Date().toISOString() }, record)
    this.data.pending = null
    this.data.lastRun = { date, result: 'published', at: new Date().toISOString() }
  }

  markSkipped(date, reason) {
    this.data.skipped[date] = { reason, at: new Date().toISOString() }
    this.data.pending = null
    this.data.lastRun = { date, result: 'skipped', reason, at: new Date().toISOString() }
  }

  setPending(pending) {
    this.data.pending = pending
    this.data.lastRun = {
      date: pending.date,
      result: 'pending',
      error: pending.lastError || null,
      at: new Date().toISOString(),
    }
  }

  clearPending() {
    this.data.pending = null
  }

  commentState(postId, commentId) {
    const post = this.data.comments[postId] || (this.data.comments[postId] = {})
    return post[commentId]
  }

  setCommentState(postId, commentId, value) {
    const post = this.data.comments[postId] || (this.data.comments[postId] = {})
    post[commentId] = Object.assign({ at: new Date().toISOString() }, value)
  }

  likeState(postId) {
    return this.data.likes[postId]
  }

  setLikeState(postId, value) {
    this.data.likes[postId] = Object.assign({ at: new Date().toISOString() }, value)
  }

  publicFeedState(key) {
    return this.data.publicFeeds[key]
  }

  setPublicFeedState(key, value) {
    this.data.publicFeeds[key] = Object.assign({ at: new Date().toISOString() }, value)
  }
}

module.exports = { JsonState, emptyState }
