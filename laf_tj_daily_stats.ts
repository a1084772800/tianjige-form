// tj_daily_stats — 天机阁网页版日报的只读统计（1028，审查 G-03：日报原读已退役企微本机库，天天报 0）
// 调用方：~/.workspace/tianjige/scripts/daily_stats.py（每晚 22:00）。
// 鉴权：请求头 x-stats-token；这里只存它的 sha256，令牌本体只在本机 ~/.workspace/runtime/secrets/tianjige_stats_token。
// 只读：只用 find / countDocuments / distinct / aggregate($match/$group，无 $out/$merge)；只回聚合数，不回任何用户号、手机号、昵称、生辰。
// 入参：POST {date:'YYYY-MM-DD'}（北京时间日）。每项单独 try：某项失败回 {err}，别项照出——调用方据此写「未取到」，绝不当 0。
// 口径（照 1028 审查 q_growth.py / q_growth2.py）：
//   只算 app_source='tianjige'；user_id 以 test_ 开头的测试号剔除（剔除数另回 test 字段）；
//   游客 / 注册＝发奖流水 points_logs add「新设备体验奖励」/「新用户奖励」（users 表没有来源字段）；
//   AI＝points_logs deduct；近 7 天＝所问日往前 7 个自然日（含当日）有 deduct 的人；
//   积分见底＝用过天机阁 AI、余额 <5、从没有过已付订单的人（当前快照，不随 date 回溯）；
//   付费＝orders status=paid，按真付款时刻落日。
// ⚠️ 付款时间刻度：notify 回调把支付平台回传的北京时间字符串当 UTC 存进 paid_at（1028 实测 59/59 笔 paid_at−created_at＝8 小时＋12 秒～25 分），
//   所以真付款时刻＝paid_at−8 小时。若某笔已付订单 paid_at−created_at 不到 8 小时−2 分＝刻度变了（回调被修过），付费项报错不出数，等人复核口径。
// 部署（laf CLI）：在 `laf app init v609a76lof` 过的目录里，本文件放 functions/tj_daily_stats.ts，
//   `laf func create tj_daily_stats -m POST -d '…'` 后 `laf func push tj_daily_stats`。
// 回滚：`laf func del tj_daily_stats`（只此一个函数；删后日报写「未取到」，不会写 0）。
import cloud from '@lafjs/cloud'
import * as crypto from 'crypto'

const TOKEN_SHA256 = 'c68de257fc5f011539904227ffd68ed69533c09df03ee4bf22005fa89c3d58b8'
const D = 86400000
const SHIFT = 8 * 3600000
const SRC = 'tianjige'
const LOW = 5
const isTest = (u: any) => typeof u === 'string' && u.startsWith('test_')
const notTest = { $not: /^test_/ }

function authorized(ctx: FunctionContext): boolean {
  const h: any = ctx.headers || {}
  const got = String(h['x-stats-token'] || '')
  if (!got) return false
  const a = crypto.createHash('sha256').update(got).digest()
  return crypto.timingSafeEqual(a, Buffer.from(TOKEN_SHA256, 'hex'))
}

function status(ctx: FunctionContext, code: number) {
  try { (ctx as any).response.status(code) } catch (e) { /* 老 runtime 无 response.status */ }
}

export default async function (ctx: FunctionContext) {
  if (!authorized(ctx)) { status(ctx, 401); return { error: 'unauthorized' } }
  const date = String((ctx.body || {}).date || '')
  const s = new Date(date + 'T00:00:00+08:00')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(s.getTime())) { status(ctx, 400); return { error: 'bad_date' } }
  const e = new Date(s.getTime() + D)
  const inDay = { $gte: s, $lt: e }
  const db = cloud.mongo.db
  const L = db.collection('points_logs'), O = db.collection('orders'), U = db.collection('users')
  const metrics: any = {}
  const run = async (k: string, f: () => Promise<any>) => {
    try { metrics[k] = { v: await f() } } catch (err) { metrics[k] = { err: String((err && (err as any).message) || err).slice(0, 200) } }
  }

  const grant = (service: string) => async () => {
    const q = { type: 'add', service, app_source: SRC, created_at: inDay }
    const all = await L.countDocuments(q)
    const n = await L.countDocuments({ ...q, user_id: notTest })
    return { n, test: all - n }
  }
  await run('guests', grant('新设备体验奖励'))
  await run('signups', grant('新用户奖励'))

  await run('ai', async () => {
    const q = { type: 'deduct', app_source: SRC, created_at: inDay }
    const ids = await L.distinct('user_id', q)
    const users = ids.filter((u: any) => !isTest(u)).length
    const times = await L.countDocuments({ ...q, user_id: notTest })
    const all = await L.countDocuments(q)
    const p = await L.aggregate([{ $match: { ...q, user_id: notTest } }, { $group: { _id: null, p: { $sum: '$points' } } }]).toArray()
    return { users, times, points: (p[0] && p[0].p) || 0, testUsers: ids.length - users, testTimes: all - times }
  })

  await run('paid', async () => {
    const rows = await O.find({ status: 'paid', app_source: SRC, paid_at: { $gte: new Date(s.getTime() + SHIFT), $lt: new Date(e.getTime() + SHIFT) } })
      .project({ _id: 0, user_id: 1, amount: 1, paid_at: 1, created_at: 1 }).toArray()
    const near = await O.find({ status: 'paid', created_at: { $gte: new Date(s.getTime() - D), $lt: new Date(e.getTime() + D) } })
      .project({ _id: 0, paid_at: 1, created_at: 1 }).toArray()
    for (const r of [...rows, ...near]) {
      const lag = new Date(r.paid_at).getTime() - new Date(r.created_at).getTime()
      if (!(lag >= SHIFT - 120000)) throw new Error('付款时间刻度变了：有已付订单的付款时间不比建单晚 8 小时，回调可能改过时区，需复核口径')
    }
    const real = rows.filter((r: any) => !isTest(r.user_id))
    let amount = 0
    for (const r of real) {
      const a = Number(r.amount)
      if (!isFinite(a) || a < 0) throw new Error('有已付订单金额不是数')
      amount += a
    }
    return { n: real.length, amount: Math.round(amount * 100) / 100, test: rows.length - real.length }
  })

  await run('active7', async () => {
    const ids = await L.distinct('user_id', { type: 'deduct', app_source: SRC, created_at: { $gte: new Date(e.getTime() - 7 * D), $lt: e } })
    return { n: ids.filter((u: any) => !isTest(u)).length }
  })

  await run('lowBalance', async () => {
    const payers = new Set((await O.distinct('user_id', { status: 'paid' })).map(String))
    const tj = (await L.distinct('user_id', { type: 'deduct', app_source: SRC })).filter((u: any) => !isTest(u))
    const rows = await U.find({ _id: { $in: tj } }).project({ points: 1, is_guest: 1 }).toArray()
    let reg = 0, guest = 0
    for (const r of rows) if ((r.points || 0) < LOW && !payers.has(String(r._id))) { if (r.is_guest) guest++; else reg++ }
    return { reg, guest }
  })

  await run('last', async () => {
    const d = await L.find({ type: 'deduct', app_source: SRC, user_id: notTest, created_at: { $lt: e } }).sort({ created_at: -1 }).limit(1).project({ _id: 0, created_at: 1 }).toArray()
    const p = await O.find({ status: 'paid', app_source: SRC, user_id: notTest, paid_at: { $lt: new Date(e.getTime() + SHIFT) } }).sort({ paid_at: -1 }).limit(1).project({ _id: 0, paid_at: 1 }).toArray()
    return { deduct: d[0] ? new Date(d[0].created_at).toISOString() : null, paid: p[0] ? new Date(new Date(p[0].paid_at).getTime() - SHIFT).toISOString() : null }
  })

  return { ok: true, date, window: { start: s.toISOString(), end: e.toISOString() }, asOf: new Date().toISOString(), metrics }
}
