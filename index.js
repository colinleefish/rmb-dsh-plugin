/**
 * RMB Desktop memory plugin for the DeepSeek Harness.
 *
 * Two directions, one local daemon:
 *
 *  - Capture: every finished turn is uploaded to `rmbd`
 *    (`POST /api/v1/sessions/<session>/upload`, `source=dsh`), where the
 *    L1→L2→L3 pipeline distils it into memories. Uploads are serialized and
 *    deduplicated by a per-session high-water mark so a resumed session never
 *    appends the same turn twice.
 *  - Recall: a bounded system-prompt section teaches the model that the memory
 *    exists, and two tools (`rmb_search`, `rmb_cat`) read it over the same
 *    loopback API the `rmb` CLI uses.
 *
 * The daemon is optional at runtime: when it is down, capture drops uploads
 * with a warning and recall tools report the failure instead of failing the
 * turn.
 *
 * @module @colinleefish/rmb-dsh-plugin
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Section name registered in the system prompt. */
const SECTION_NAME = 'memory:rmb'
/** Rendered just before the local `memory:long-term` section (4500). */
const SECTION_ORDER = 4400
const DEFAULT_BASE_URL = 'http://127.0.0.1:19019'
const DEFAULT_SOURCE = 'dsh'
/** Per-message cap before upload; longer messages are truncated. */
const MAX_MESSAGE_CHARS = 12000
/** Per-upload cap across all messages of one turn. */
const MAX_TURN_CHARS = 40000
/** Cap for one `rmb_cat` result. */
const MAX_CAT_CHARS = 20000
/**
 * Harness injects several synthetic `user/message` events (runtime context,
 * skill catalog, AGENTS.md, clock). Only `source.kind === 'user'` is a real
 * human (or parent-agent) utterance worth remembering.
 */
const CAPTURE_USER_KINDS = new Set(['user'])

/** Services this plugin cannot work without; `sessionQuery` is read lazily. */
export const inject = ['tools', 'systemPrompt']

/** The prompt block that makes the model aware of RMB. */
const GUIDE = `## 长期记忆（RMB Desktop）

本机运行 RMB Desktop 长期记忆库，跨会话、跨 agent 共享。先查，再问用户。

- \`rmb_search\`：混合检索（记忆 + 技能）。参数 query 必填，k 默认 8，scope 可选 memory/scene/skill/atom，since/until 限定时间窗口（如 7d、2026-08-01）。
- \`rmb_cat\`：按 URI 读取单条记忆、场景或技能的全文；URI 只能来自检索结果或列表，不要自己拼。

规则：

1. 用户说“上次”“之前”“我跟你说过”，或问题涉及既有决策、偏好、主机、项目时，先 rmb_search。
2. 命中后需要细节就 rmb_cat，引用时给出 rmb:// URI。
3. 结果里的 v= 是该记忆被改写的版本数；v 高说明被反复重写、可信度下降，用 rmb_cat 或证据场景核实。
4. 搜不到就直说没有记录，不要编造 URI 或内容。`

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Expand a leading `~/` so a hand-written patch path still resolves. */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** Read one integer option within bounds, falling back to `fallback`. */
function integerOption(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Normalize the row config. Malformed fields fall back to defaults instead of
 * failing activation, so a hand-edited patch cannot disable capture silently.
 */
function resolveConfig(raw) {
  const input = isRecord(raw) ? raw : {}
  const baseUrl = trimText(input.baseUrl) || DEFAULT_BASE_URL
  return {
    enabled: input.enabled !== false,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    source: trimText(input.source) || DEFAULT_SOURCE,
    capture: input.capture !== false,
    timeoutMs: integerOption(input.timeoutMs, 6000, 500, 60000),
    maxPromptChars: integerOption(input.maxPromptChars, 2000, 0, 20000),
    statePath: expandHome(trimText(input.statePath)) || join(dshHome(), 'rmb-memory', 'state.json'),
  }
}

/** Join the text blocks of one message; non-text blocks become placeholders. */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[image]')
    } else if (block.type === 'file') {
      parts.push(`[file ${isRecord(block.attachment) ? block.attachment.name ?? '' : ''}]`.trim())
    }
  }
  return parts.join('\n')
}

/** Cap one message and the running total of a turn. */
function pushMessage(out, role, text, budget) {
  const body = trimText(text)
  if (body.length === 0) return budget
  const room = Math.min(MAX_MESSAGE_CHARS, budget)
  if (room <= 0) return 0
  const clipped = body.length > room ? `${body.slice(0, room)}\n…[truncated]` : body
  out.push({ role, content: clipped })
  return budget - clipped.length
}

async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (isRecord(parsed) && isRecord(parsed.sessions)) return { sessions: { ...parsed.sessions } }
  } catch {
    // Missing or corrupt state: start clean rather than blocking capture.
  }
  return { sessions: {} }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * Register the memory section and tools for one activation.
 * @param ctx - plugin context.
 * @param rawConfig - row config; malformed fields fall back to defaults.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const logger = ctx.logger
  const cache = { profile: '' }

  async function request(pathname) {
    const response = await fetch(`${config.baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) {
      const detail = (await response.text()).trim()
      throw new Error(`rmbd ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return response
  }

  // ---- Recall: profile excerpt in the system prompt ----------------------
  async function refreshProfile() {
    try {
      const response = await request(`/api/v1/inspect/cat?uri=${encodeURIComponent('rmb://profile')}`)
      cache.profile = (await response.text()).trim()
    } catch (error) {
      logger?.debug?.(`rmb-memory: profile refresh skipped (${errorMessage(error)})`)
    }
  }
  void refreshProfile()
  ctx.effect(() => {
    const timer = setInterval(() => void refreshProfile(), 10 * 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: () => {
      if (config.maxPromptChars === 0) return GUIDE
      const room = Math.max(0, config.maxPromptChars - GUIDE.length)
      if (room === 0 || cache.profile.length === 0) return GUIDE
      const profile = cache.profile.length > room
        ? `${cache.profile.slice(0, room)}\n…[truncated]`
        : cache.profile
      return `${GUIDE}\n\n## 用户档案（RMB profile）\n\n${profile}`
    },
  })

  // ---- Recall: tools -----------------------------------------------------
  ctx.tools.register({
    name: 'rmb_search',
    description:
      'Search RMB Desktop long-term memory (memories + skills). Use before asking the user about prior decisions, preferences, hosts, or projects.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to look up, in natural language.' },
        k: { type: 'integer', description: 'Number of hits, 1-50. Defaults to 8.', minimum: 1, maximum: 50 },
        scope: {
          type: 'string',
          description: 'Comma-separated tiers: memory, scene, skill, atom. Defaults to memory+skill.',
        },
        since: { type: 'string', description: 'Only hits updated since this point: 7d, 12h, 2026-08-01.' },
        until: { type: 'string', description: 'Only hits updated before this point.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['text', 'count'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args) {
      const query = trimText(args?.query)
      if (query.length === 0) throw new Error('`query` must be a non-empty string')
      const params = new URLSearchParams({ q: query })
      if (args?.k !== undefined) params.set('k', String(args.k))
      const scope = trimText(args?.scope)
      if (scope.length > 0) params.set('scope', scope)
      const since = trimText(args?.since)
      if (since.length > 0) params.set('since', since)
      const until = trimText(args?.until)
      if (until.length > 0) params.set('until', until)

      let payload
      try {
        payload = await (await request(`/api/v1/search?${params.toString()}`)).json()
      } catch (error) {
        throw new Error(`RMB search failed: ${errorMessage(error)} (is rmbd running?)`)
      }
      const items = Array.isArray(payload?.items) ? payload.items : []
      if (items.length === 0) return { text: `No RMB memory matched "${query}".`, count: 0 }
      const lines = items.map((item, index) => {
        const version = Number(item?.version) > 0 ? `v=${item.version}` : '—'
        return `${index + 1}. [${item?.tier ?? '?'}] ${item?.uri ?? '?'} (${version})\n   ${trimText(item?.snippet)}`
      })
      return { text: lines.join('\n'), count: items.length }
    },
  })

  ctx.tools.register({
    name: 'rmb_cat',
    description: 'Read one RMB URI in full (memory, scene, or skill). The URI must come from rmb_search output.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uri: { type: 'string', description: 'An rmb:// URI from rmb_search output.' },
      },
      required: ['uri'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args) {
      const uri = trimText(args?.uri)
      if (!uri.startsWith('rmb://')) throw new Error('`uri` must be an rmb:// URI')
      let body
      try {
        body = await (await request(`/api/v1/inspect/cat?uri=${encodeURIComponent(uri)}`)).text()
      } catch (error) {
        throw new Error(`RMB read failed: ${errorMessage(error)} (is rmbd running?)`)
      }
      const text = body.length > MAX_CAT_CHARS ? `${body.slice(0, MAX_CAT_CHARS)}\n…[truncated]` : body
      return { text }
    },
  })

  // ---- Capture: finished turns → rmbd -----------------------------------
  if (!config.capture) return

  const buffers = new Map()
  const resume = { lastTurn: new Map() }

  function bufferFor(sessionId) {
    let buffer = buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { turn: -1, messages: [], budget: MAX_TURN_CHARS }
      buffers.set(sessionId, buffer)
    }
    return buffer
  }

  const queue = { tail: Promise.resolve() }

  function sessionKeyOf(session) {
    const id = session?.id ?? session?.header?.id
    return typeof id === 'string' ? id.trim() : ''
  }

  async function highWater(sessionId) {
    if (resume.lastTurn.has(sessionId)) return resume.lastTurn.get(sessionId)
    const state = await loadState(config.statePath)
    for (const [key, value] of Object.entries(state.sessions)) {
      if (isRecord(value) && Number.isInteger(value.lastTurn)) resume.lastTurn.set(key, value.lastTurn)
    }
    return resume.lastTurn.get(sessionId) ?? -1
  }

  async function recordHighWater(sessionId, turn) {
    resume.lastTurn.set(sessionId, turn)
    try {
      const state = await loadState(config.statePath)
      state.sessions[sessionId] = { lastTurn: turn, updatedAt: new Date().toISOString() }
      await saveState(config.statePath, state)
    } catch (error) {
      logger?.warn?.(`rmb-memory: cannot persist capture state (${errorMessage(error)})`)
    }
  }

  async function upload(sessionId, turn, messages) {
    if ((await highWater(sessionId)) >= turn) return
    const body = JSON.stringify({ source: config.source, messages })
    try {
      const response = await fetch(
        `${config.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/upload`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(config.timeoutMs),
        },
      )
      if (!response.ok) {
        const detail = (await response.text()).trim()
        throw new Error(`rmbd ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      await recordHighWater(sessionId, turn)
    } catch (error) {
      logger?.warn?.(`rmb-memory: upload failed for ${sessionId} turn ${turn} (${errorMessage(error)})`)
    }
  }

  function flush(sessionId, turn) {
    const buffer = buffers.get(sessionId)
    buffers.delete(sessionId)
    if (buffer === undefined || buffer.messages.length === 0) return
    if (buffer.turn !== turn) return
    queue.tail = queue.tail
      .then(() => upload(sessionId, turn, buffer.messages))
      .catch((error) => logger?.warn?.(`rmb-memory: capture queue error (${errorMessage(error)})`))
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = sessionKeyOf(session)
    if (sessionId.length === 0 || !isRecord(event)) return
    switch (event.type) {
      case 'turn/start': {
        const turn = Number(event.data?.turn ?? -1)
        buffers.set(sessionId, { turn, messages: [], budget: MAX_TURN_CHARS })
        return
      }
      case 'user/message': {
        const kind = isRecord(event.data?.source) ? trimText(event.data.source.kind) : 'user'
        if (!CAPTURE_USER_KINDS.has(kind || 'user')) return
        const buffer = bufferFor(sessionId)
        const text = blocksToText(event.data?.content)
        if (text.trim().length > 0) buffer.budget = pushMessage(buffer.messages, 'user', text, buffer.budget)
        return
      }
      case 'assistant/message': {
        // Keep the final spoken reply; skip reasoning-only / tool-only steps.
        const text = blocksToText(event.data?.message?.content)
        if (text.trim().length === 0) return
        const buffer = bufferFor(sessionId)
        buffer.budget = pushMessage(buffer.messages, 'assistant', text, buffer.budget)
        return
      }
      case 'turn/end': {
        flush(sessionId, Number(event.data?.turn ?? -1))
        return
      }
      default:
        return
    }
  })
}
