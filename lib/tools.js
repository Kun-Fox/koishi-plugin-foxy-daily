'use strict'

const TOOL_GROUP = 'foxy-daily'

function loadLangChain() {
  try {
    const tools = require('@langchain/core/tools')
    const { z } = require('zod')
    if (tools?.tool && z) return { ...tools, z }
  } catch {}
  return null
}

function allowed(config, session) {
  if (!session) return false
  const ids = (config.allowUserIds || []).map(String)
  if (ids.length === 0) return false
  return ids.includes(String(session.userId))
}

function descriptions(config) {
  return {
    publish: `发布一条 QQ 空间动态。content 为空时从 Foxy Memory 的指定日期/今日记忆生成；日期格式 YYYY-MM-DD。`,
    comments: `读取机器人自己动态下的评论。post_id 为空时读取最近 ${config.monitorPostLimit || 10} 条动态。`,
    reply: '回复机器人自己动态下的一条评论。必须提供动态 ID、评论 ID 和回复正文。',
  }
}

function registerChatLunaTools(ctx, service, config, logger) {
  const platform = ctx.chatluna?.platform || ctx.chatluna
  if (!platform?.registerTool) return []
  const lc = loadLangChain()
  if (!lc) {
    logger?.warn?.('未找到 @langchain/core/tools，跳过 ChatLuna 工具注册')
    return []
  }
  const { tool, z } = lc
  const desc = descriptions(config)
  const disposers = []

  const publishTool = tool(async (input, _runManager, runnable) => {
    return service.handleTool('publish', input, runnable?.configurable?.session)
  }, {
    name: 'qzone_publish',
    description: desc.publish,
    schema: z.object({
      content: z.string().optional().describe('直接发布的正文；留空则根据 Foxy Memory 生成'),
      date: z.string().optional().describe('记忆日期 YYYY-MM-DD；留空为今天/凌晨自动取昨天'),
    }),
  })

  const commentsTool = tool(async (input, _runManager, runnable) => {
    return service.handleTool('comments', input, runnable?.configurable?.session)
  }, {
    name: 'qzone_comments',
    description: desc.comments,
    schema: z.object({
      post_id: z.string().optional().describe('动态 ID；留空读取最近动态'),
    }),
  })

  const replyTool = tool(async (input, _runManager, runnable) => {
    return service.handleTool('reply', input, runnable?.configurable?.session)
  }, {
    name: 'qzone_reply',
    description: desc.reply,
    schema: z.object({
      post_id: z.string().describe('动态 ID'),
      comment_id: z.string().describe('评论 ID'),
      content: z.string().describe('回复正文'),
    }),
  })

  const specs = [
    ['qzone_publish', publishTool, desc.publish],
    ['qzone_comments', commentsTool, desc.comments],
    ['qzone_reply', replyTool, desc.reply],
  ]
  for (const [name, instance, description] of specs) {
    try {
      const dispose = platform.registerTool(name, {
        name,
        description,
        createTool: () => instance,
        selector: () => true,
        authorization: (session) => allowed(config, session),
        meta: {
          source: 'extension',
          group: TOOL_GROUP,
          tags: ['qzone', 'qq', 'daily', 'comment'],
          defaultAvailability: {
            enabled: true,
            main: true,
            subAgent: false,
            chatluna: true,
            characterScope: 'all',
          },
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logger?.warn?.(`ChatLuna 工具 ${name} 注册失败：${error.message}`)
    }
  }
  return disposers
}

function fieldSchema(action, config) {
  if (action === 'publish') {
    return {
      type: 'object',
      properties: {
        content: { type: 'string', description: '直接发布的正文；留空则根据记忆生成' },
        date: { type: 'string', description: '记忆日期 YYYY-MM-DD' },
      },
    }
  }
  if (action === 'comments') {
    return {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: '动态 ID；留空读取最近动态' },
      },
    }
  }
  return {
    type: 'object',
    properties: {
      post_id: { type: 'string', description: '动态 ID' },
      comment_id: { type: 'string', description: '评论 ID' },
      content: { type: 'string', description: '回复正文' },
    },
    required: ['post_id', 'comment_id', 'content'],
  }
}

function registerCharacterFields(ctx, service, config, logger) {
  const character = ctx.chatluna_character
  if (!character?.registerReplyToolField) return []
  const desc = descriptions(config)
  const disposers = []
  const fields = [
    ['qzone_publish', 'publish', desc.publish],
    ['qzone_comments', 'comments', desc.comments],
    ['qzone_reply', 'reply', desc.reply],
  ]
  for (const [name, action, description] of fields) {
    try {
      const dispose = character.registerReplyToolField({
        name,
        schema: {
          type: 'array',
          description,
          items: fieldSchema(action, config),
        },
        isAvailable: (_ctx, session) => allowed(config, session),
        invoke: async (_ctx, session, value) => {
          if (!Array.isArray(value)) return
          for (const item of value) {
            if (!item || typeof item !== 'object') continue
            try {
              await service.handleTool(action, item, session)
            } catch (error) {
              logger?.warn?.(`Character ${name} 执行失败：${error.message}`)
            }
          }
        },
        render: (_ctx, _session, value) => {
          if (!Array.isArray(value)) return ''
          return value
            .filter((item) => item && typeof item === 'object')
            .map((item) => {
              const attrs = Object.entries(item)
                .filter(([, val]) => val != null && val !== '')
                .map(([key, val]) => `${key}="${String(val).replace(/"/g, '&quot;')}"`)
                .join(' ')
              return `<${name}${attrs ? ' ' + attrs : ''} />`
            })
            .join('\n')
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logger?.warn?.(`Character 字段 ${name} 注册失败：${error.message}`)
    }
  }
  return disposers
}

function registerQzoneTools(ctx, service, config, logger) {
  const disposers = []
  if (config.toolEnabled !== false) {
    disposers.push(...registerChatLunaTools(ctx, service, config, logger))
  }
  if (config.characterToolEnabled !== false) {
    disposers.push(...registerCharacterFields(ctx, service, config, logger))
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {}
    }
  }
}

module.exports = { registerQzoneTools, allowed }
