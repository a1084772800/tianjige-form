import cloud from '@lafjs/cloud'

const db = cloud.database()

export default async function (ctx: FunctionContext) {
  const { id } = ctx.query || {}

  if (!id) {
    return { error: 'missing render id' }
  }

  try {
    const res = await db.collection('renders').where({ render_id: id }).getOne()
    if (!res.data) {
      return { error: 'not found' }
    }

    // 检查过期
    if (res.data.expires_at && res.data.expires_at < Date.now()) {
      return { error: 'expired' }
    }

    // 浏览量+1
    await db.collection('renders').where({ render_id: id }).update({
      views: (res.data.views || 0) + 1,
    })

    return {
      success: true,
      title: res.data.title,
      html: res.data.html,
      created_at: res.data.created_at,
    }
  } catch (e) {
    console.error('get_render error:', e)
    return { error: 'internal error' }
  }
}
