import cloud from '@lafjs/cloud'

const db = cloud.database()

export default async function (ctx: FunctionContext) {
  const { id } = ctx.query || {}

  if (!id) {
    return { error: 'missing report id' }
  }

  try {
    const res = await db.collection('reports').where({ report_id: id }).getOne()
    if (!res.data) {
      return { error: 'report not found' }
    }
    // 浏览量+1
    await db.collection('reports').where({ report_id: id }).update({ views: (res.data.views || 0) + 1 })
    return {
      success: true,
      report: {
        title: res.data.title,
        content: res.data.content,
        report_type: res.data.report_type,
        card_image: res.data.card_image,
        created_at: res.data.created_at,
      }
    }
  } catch (e) {
    console.error('get_report error:', e)
    return { error: 'internal error' }
  }
}
