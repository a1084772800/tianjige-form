import cloud from '@lafjs/cloud'

const db = cloud.database()

// 1MB cap (与 render_tool.py 客户端预检对齐)
const MAX_HTML_BYTES = 1024 * 1024

// XSS 模式黑名单：覆盖 top.location / document.cookie / eval / inline event handler / javascript: URI / data:text/html / meta refresh 等经典注入向量。
// 主防线是 token auth + iframe sandbox（无 same-origin / 无 top-navigation），这层是定向阻断。
// 注意：业务页面允许 onclick="copyCmd(this)" 等普通 UI 事件，所以 inline event 不能整体拉黑。
// 仅拦"经典攻击向量"（onerror=/onload= 在 img/iframe 上 + javascript: + meta refresh）
const XSS_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'script_top_location', re: /<script[^>]*>[\s\S]*?(?:\btop\b|window\s*\.\s*top|\bparent\b|window\s*\.\s*parent)\s*\.\s*location[\s\S]*?<\/script>/i },
  { name: 'script_document_cookie', re: /<script[^>]*>[\s\S]*?document\s*\.\s*cookie[\s\S]*?<\/script>/i },
  { name: 'script_eval_or_function_ctor', re: /<script[^>]*>[\s\S]*?(?:\beval\s*\(|new\s+Function\s*\()[\s\S]*?<\/script>/i },
  // onerror= / onload= 几乎只用于 <img src=x onerror=...> / <body onload=...> 经典 XSS payload，业务页面不该出现
  { name: 'tag_onerror_handler', re: /<[a-zA-Z][^>]*\sonerror\s*=/i },
  { name: 'tag_onload_handler', re: /<(?:img|iframe|body|svg|video|audio|object|embed)[^>]*\sonload\s*=/i },
  { name: 'javascript_uri', re: /(?:href|src|xlink:href|action|formaction|data|background|poster)\s*=\s*["']?\s*javascript:/i },
  { name: 'data_text_html', re: /(?:src|href)\s*=\s*["']?\s*data\s*:\s*text\/html/i },
  { name: 'meta_refresh_redirect', re: /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*url\s*=/i },
]

function sniffXss(html: string): string[] {
  // 早返：命中第一个就回，不必扫完 9 条（平均扫 ~5 条 → 1 条）
  for (const p of XSS_PATTERNS) {
    if (p.re.test(html)) return [p.name]
  }
  return []
}

export default async function (ctx: FunctionContext) {
  // 1. Token 鉴权 (X-Save-Token header；token 来自 cloud 环境变量 RENDER_SAVE_TOKEN)
  const expected = (process.env.RENDER_SAVE_TOKEN || '').trim()
  if (!expected) {
    // 配置缺失视为防呆失败，宁可拒所有写入也不裸奔
    return { error: 'server_misconfigured: RENDER_SAVE_TOKEN unset' }
  }
  const headers: any = ctx.headers || {}
  const got = (headers['x-save-token'] || headers['X-Save-Token'] || '').toString().trim()
  if (got !== expected) {
    return { error: 'unauthorized' }
  }

  const body = ctx.body || {}
  const { render_id, title, html, expires_in } = body

  if (!render_id || !html) {
    return { error: 'missing render_id or html' }
  }
  if (typeof html !== 'string') {
    return { error: 'html must be string' }
  }

  // 2. Size guard (1MB)
  const htmlBytes = Buffer.byteLength(html, 'utf8')
  if (htmlBytes > MAX_HTML_BYTES) {
    return { error: 'html_too_large', actual: htmlBytes, max: MAX_HTML_BYTES }
  }

  // 3. XSS sanitize：命中任意黑名单直接拒绝
  const xssHits = sniffXss(html)
  if (xssHits.length > 0) {
    console.warn(`[save_render] xss_blocked render_id=${render_id} hits=${xssHits.join(',')}`)
    return { error: 'xss_blocked', patterns: xssHits }
  }

  // 默认7天过期，0=永不过期
  const ttl = expires_in || 7 * 24 * 3600 * 1000
  const expires_at = ttl > 0 ? Date.now() + ttl : 0

  try {
    // upsert：相同 render_id 覆盖更新
    const existing = await db.collection('renders').where({ render_id }).getOne()
    if (existing.data) {
      await db.collection('renders').where({ render_id }).update({
        title: title || '动态页面',
        html,
        expires_at,
        updated_at: Date.now(),
      })
    } else {
      await db.collection('renders').add({
        render_id,
        title: title || '动态页面',
        html,
        expires_at,
        created_at: Date.now(),
        updated_at: Date.now(),
        views: 0,
      })
    }
    return { success: true, render_id }
  } catch (e) {
    console.error('save_render error:', e)
    return { error: 'internal error' }
  }
}
