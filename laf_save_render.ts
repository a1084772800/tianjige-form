import cloud from '@lafjs/cloud'

const db = cloud.database()

export default async function (ctx: FunctionContext) {
  const body = ctx.body || {}
  const { render_id, title, html, expires_in } = body

  if (!render_id || !html) {
    return { error: 'missing render_id or html' }
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
