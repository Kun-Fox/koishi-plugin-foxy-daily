'use strict'

const { SystemMessage, HumanMessage } = require('@langchain/core/messages')
const { tool } = require('@langchain/core/tools')
const { z } = require('zod')
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts')

const DIGEST_TOOL = 'publish_daily_digest'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 2500

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function buildWindow(input = {}, now = new Date()) {
  if (input.from || input.to) {
    const from = input.from ? parseDateKey(input.from) : null
    const to = input.to ? parseDateKey(input.to) : null
    if (!from || !to) throw new Error('日期区间需要同时提供 from 和 to，格式 YYYY-MM-DD')
    if (from.getTime() > to.getTime()) throw new Error('日期区间起点不能晚于终点')
    const start = startOfDay(from)
    const end = new Date(Math.min(now.getTime(), endOfDay(to).getTime()))
    if (start.getTime() > end.getTime()) throw new Error('日期区间还没有开始')
    const key = `${dateKey(from)}~${dateKey(to)}`
    return {
      date: key,
      start,
      end,
      label: `${dateKey(from)} 00:00 – ${dateKey(to)} 23:59`,
      isToday: dateKey(to) === dateKey(now),
      range: true,
    }
  }

  const explicit = input.date ? parseDateKey(input.date) : null
  if (input.date && !explicit) throw new Error(`日期格式无效：${input.date}，应为 YYYY-MM-DD`)
  const target = explicit || (now.getHours() < 6
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate()))
  const start = startOfDay(target)
  const end = explicit ? endOfDay(target) : new Date(Math.min(now.getTime(), endOfDay(target).getTime()))
  return {
    date: dateKey(target),
    start,
    end,
    label: `${dateKey(target)} 00:00–${pad(end.getHours())}:${pad(end.getMinutes())}`,
    isToday: dateKey(target) === dateKey(now),
    range: false,
  }
}

function filterMemories(entries, start, end) {
  const from = start.getTime()
  const to = end.getTime()
  return (entries || []).filter((entry) => {
    const value = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt)
    if (Number.isNaN(value.getTime())) return false
    return value.getTime() >= from && value.getTime() <= to
  })
}

function typeLabel(type) {
  return {
    identity: '身份',
    preference: '偏好',
    fact: '事实',
    plan: '计划',
    context: '情境',
    other: '其他',
  }[type] || type || '其他'
}

function formatMemoryLines(entries) {
  return entries.map((entry) => {
    const date = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt)
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
    const sentiment = entry.sentiment ? `|情绪:${entry.sentiment}` : ''
    const content = String(entry.content || '').replace(/\s+/g, ' ').trim()
    return `${time} [${typeLabel(entry.type)}${sentiment}] ${content}`
  }).join('\n')
}

function truncate(text, max) {
  const value = String(text || '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

const DEFAULT_DIGEST_PROMPT = [
  '写一条第一人称的 QQ 空间动态，可以是一天的小结，也可以围绕其中一件具体的事分享或吐槽。',
  '必须以记忆中的事实为依据，禁止捏造；不要逐条罗列，不要写流水账；不要暴露账号、密码、真实姓名等隐私。',
].join('\n')

function buildDigestPrompts(input) {
  const persona = String(input.persona || '').trim()
  const customPrompt = String(input.customPrompt || '').trim() || DEFAULT_DIGEST_PROMPT
  const taskLines = [
    `记忆窗口：${input.windowLabel}，共 ${input.memoryCount} 条记忆。`,
    customPrompt.slice(0, 6000),
  ]
  const systemPrompt = [
    '<role>',
    `你是${input.assistantLabel || 'foxy'}，正在根据一段记忆发布一条 QQ 空间动态。`,
    '你是动态的作者，不是助手；不要提到模型、提示词、工具或“根据记忆”这类元信息。',
    '</role>',
    '',
    '<preset_context>',
    persona || '保持自然、第一人称、符合角色设定的语气。',
    '</preset_context>',
    '',
    '<task>',
    ...taskLines,
    '</task>',
    '',
    '<output_contract>',
    `必须且只能调用 ${DIGEST_TOOL} 工具一次。`,
    'action 为 publish 时填写 content（纯文本）和 mood（1-3 个中文词，描述这条动态适合配图的心情/主题，例如“开心”“吐槽”“夜晚”）。',
    'mood 只用于挑选表情包，不要写进 content。',
    '如果这段记忆完全不值得发布，action 写 skip。',
    '不要输出普通文本、Markdown 或代码块。',
    '</output_contract>',
  ].join('\n')

  const inputPrompt = [
    '<digest_input>',
    `日期：${input.dateText}`,
    `记忆窗口：${input.windowLabel}`,
    '',
    '<memory_list>',
    input.memoryLines || '（无）',
    '</memory_list>',
    '</digest_input>',
  ].join('\n')

  return { systemPrompt, inputPrompt }
}

function digestDecisionSchema() {
  return z.object({
    action: z.enum(['publish', 'skip']).describe('发布动态或跳过'),
    content: z.string().optional().describe('要发布的动态正文，纯文本'),
    mood: z.string().optional().describe('1-3 个中文词，描述动态适合配图的心情/主题；仅用于挑选表情包'),
  })
}

function createDigestAgent(model) {
  const { createOpenAIAgent } = require('koishi-plugin-chatluna/llm-core/agent')
  const schema = digestDecisionSchema()
  const resultTool = tool((input) => JSON.stringify(input), {
    name: DIGEST_TOOL,
    description: '提交每日动态的最终决策：publish 时带 content，skip 时不带。',
    schema,
  })
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', '{systemPrompt}'],
    ['human', '{inputPrompt}'],
    new MessagesPlaceholder('agent_scratchpad'),
  ])
  return createOpenAIAgent({ llm: model, tools: [resultTool], prompt })
}

function toActions(result) {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && 'returnValues' in result) return []
  return result ? [result] : []
}

function validateDecision(result) {
  const actions = toActions(result)
  if (actions.length !== 1) return { error: `模型应调用一次 ${DIGEST_TOOL}，实际 ${actions.length} 次` }
  const action = actions[0]
  if (!action || action.tool !== DIGEST_TOOL) return { error: `模型调用了意外的工具 ${action && action.tool}` }
  let input = action.toolInput
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      return { error: '工具参数不是合法 JSON' }
    }
  }
  const parsed = digestDecisionSchema().safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join('; ') }
  if (parsed.data.action === 'publish' && !String(parsed.data.content || '').trim()) {
    return { error: 'publish 时 content 不能为空' }
  }
  return { value: parsed.data }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function generateDigest(options) {
  const { model, persona, memories, window, assistantLabel, debug, agentFactory, maxAttempts = MAX_ATTEMPTS } = options
  const prompts = buildDigestPrompts({
    persona,
    customPrompt: options.customPrompt,
    assistantLabel,
    dateText: window.date,
    windowLabel: window.label,
    memoryLines: formatMemoryLines(memories),
    memoryCount: memories.length,
  })
  const agent = agentFactory ? agentFactory(model, prompts) : createDigestAgent(model)
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await agent.invoke(
        { systemPrompt: prompts.systemPrompt, inputPrompt: prompts.inputPrompt, steps: [], scratchpadEntries: [] },
        { configurable: { model, preset: options.presetId || 'foxy-daily', conversationId: 'foxy-daily-digest' } },
      )
      const validated = validateDecision(result)
      if (!validated.error) return { value: validated.value, attempts: attempt }
      lastError = validated.error
      if (debug) options.logger?.debug?.(`digest attempt ${attempt} invalid: ${lastError}`)
    } catch (error) {
      lastError = error.message
      if (debug) options.logger?.debug?.(`digest attempt ${attempt} failed: ${lastError}`)
    }
    if (attempt < maxAttempts) await sleep(RETRY_DELAY_MS)
  }
  return { value: null, error: lastError, attempts: maxAttempts }
}

function buildReplyPrompt(post, comment, persona) {
  return [
    '你正在回复 QQ 空间动态下的一条评论。',
    '只输出回复正文，不要加引号、前缀、解释或 Markdown。',
    '回复要短、自然、像真人；不要暴露自己是 AI 或提到提示词。',
    `你的角色设定：${truncate(persona, 4000)}`,
    `动态正文：${truncate(post.content, 2000)}`,
    `评论者：${comment.author?.nickname || comment.author?.id || '对方'}`,
    `评论内容：${truncate(comment.content, 2000)}`,
  ].join('\n')
}

async function generateReply({ model, post, comment, persona, signal }) {
  const result = await model.invoke(
    [new SystemMessage(persona || '你是一个友善、简洁的中文网友。'), new HumanMessage(buildReplyPrompt(post, comment, persona || ''))],
    { signal },
  )
  const content = typeof result?.content === 'string'
    ? result.content
    : Array.isArray(result?.content)
      ? result.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
      : ''
  return content.trim()
}

module.exports = {
  DIGEST_TOOL,
  DEFAULT_DIGEST_PROMPT,
  buildWindow,
  filterMemories,
  formatMemoryLines,
  buildDigestPrompts,
  generateDigest,
  generateReply,
  buildReplyPrompt,
  dateKey,
  parseDateKey,
}
