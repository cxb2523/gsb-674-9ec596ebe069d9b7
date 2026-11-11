#!/usr/bin/env node
/**
 * 抽帧 / 场景检测链路的离线质量保障（不依赖真实 ffmpeg、网络或用户缓存目录）。
 *
 * 与 c225/c229 两个真跑夹具的分工：那两个必须本机有 ffmpeg、合成真片才能跑；
 * 本夹具把「外部世界」全部换成注入物——
 *   · sceneTimes 的 hsv 注入口直接给桩；回落路用一个不存在的 bin 触发（不起真进程）；
 *   · hsvSceneTimes 的 run 注入成按 args 返回构造 rawvideo Buffer 的假函数；
 *   · 帧缓存读写全部落在 mkdtemp 出来的临时目录里，结束即删。
 *
 * 覆盖四类契约（任一断言失败 → 进程退出码 1；全过 → 0）：
 *   一、sceneTimes 的 method 语义：hsv 失败不回落 / auto 失败回落且 onFallback 到 /
 *       auto 零切点（ok:true + times:[]）不回落——零切点是结果不是失败。
 *   二、hsvSceneTimes 分段：切点时间戳按全局计时（start + i/fps）、跨段 prev 不断、
 *       首段空 = ok:false、后续段空 = EOF 正常结束、run 抛错按失败表达、maxBuffer 按段算。
 *   三、framesCacheHit：step / scene / times 任一不同即不命中；
 *       老 manifest（无 times 字段）在非 at 模式下仍命中、at 请求下不命中。
 *   四、parseAtTimes：区间起点大于终点抛错、非法格式抛错、去重升序、
 *       atDirTag 对不同时刻集合给出不同且稳定的目录标签。
 *
 * 用法：node tools/fixtures/offline-scene-frames-probe.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atDirTag, framesCacheHit, parseAtTimes, sceneTimes } from '../../lib/media.mjs'
import { hsvSceneTimes } from '../../lib/scene-hsv.mjs'
import { readManifest, writeManifest } from '../../lib/frames.mjs'

// ── 迷你测试框架：失败计数 + 逐条 PASS/FAIL，结尾按计数决定退出码 ──────────────
let failures = 0
let passes = 0
const fails = []
function check(name, fn) {
  try {
    fn()
    passes++
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    fails.push({ name, msg: String(e?.message || e) })
    console.log(`FAIL  ${name}\n      ${String(e?.message || e).split('\n').join('\n      ')}`)
  }
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label || '值不相等'}：期望 ${e}，实际 ${a}`)
}
const truthy = (v, label) => { if (!v) throw new Error(`${label || '断言'}：期望真值，实际 ${JSON.stringify(v)}`) }
const throws = (fn, re, label) => {
  let threw = null
  try { fn() } catch (e) { threw = e }
  if (!threw) throw new Error(`${label}：应当抛错却正常返回`)
  if (re && !re.test(String(threw.message))) throw new Error(`${label}：报错文案不匹配 ${re}，实际「${threw.message}」`)
}

const tmp = mkdtempSync(join(tmpdir(), 'bw-offline-scene-'))
try {
  // ══════════════════════ 一、sceneTimes 的 method 语义 ══════════════════════
  // 桩一律带固定 why，回落走 scdet 时 why 会换成 scdet 自己的文案——用它区分两路。
  const HSV_FAIL = { times: [], ok: false, why: '桩：HSV 被故意打坏' }
  const HSV_ZERO = { times: [], ok: true, why: '' }
  const HSV_HITS = { times: [12.5, 40], ok: true, why: '' }
  const missingBin = join(tmp, 'no-such-ffmpeg-离线夹具')
  const fakeFile = join(tmp, 'sample.mp4')

  check("一-1 method='hsv'：HSV 返回 ok:false 也不得回落 scdet（原样透传失败）", () => {
    let scdetCalls = 0
    const r = sceneTimes(fakeFile, 0.3, missingBin, {
      method: 'hsv',
      hsv: () => { scdetCalls++; return HSV_FAIL },
      onFallback: () => { throw new Error('hsv 模式不该触发 onFallback') },
    })
    eq(r.ok, false, 'ok')
    eq(r.times, [], 'times')
    eq(r.why, HSV_FAIL.why, 'why 必须是 HSV 桩的文案；换成 scdet 文案就是发生了回落')
    eq(scdetCalls, 1, 'HSV 注入桩必须恰好被调用一次')
  })

  check("一-2 method='auto'：HSV 返回 ok:false 必须回落 scdet 并触发 onFallback", () => {
    const notes = []
    let hsvCalls = 0
    const r = sceneTimes(fakeFile, 0.3, missingBin, {
      // 默认就是 auto，这里显式写出让用例自解释
      method: 'auto',
      hsv: () => { hsvCalls++; return HSV_FAIL },
      onFallback: (why) => notes.push(why),
    })
    eq(hsvCalls, 1, 'HSV 桩调用次数')
    eq(notes, [HSV_FAIL.why], 'onFallback 必须收到 HSV 的 why 且恰好一次')
    // 回落进 scdet：bin 不存在 → scdet 也失败，但返回形状必须是 scdet 的失败形状，
    // 而不是 HSV 桩的形状（why 文案不同即证明走的是旧路）。
    eq(r.ok, false, '回落 scdet 后仍失败时 ok')
    eq(r.times, [], '回落 scdet 后仍失败时 times')
    truthy(r.why && r.why !== HSV_FAIL.why && /ffmpeg 场景检测失败/.test(r.why),
      `why 应来自 scdet 路，实际「${r.why}」`)
  })

  check("一-3 method='auto'：HSV 返回 ok:true + times:[]（零切点）不得回落", () => {
    const notes = []
    let hsvCalls = 0
    const r = sceneTimes(fakeFile, 0.3, missingBin, {
      method: 'auto',
      hsv: () => { hsvCalls++; return HSV_ZERO },
      onFallback: () => notes.push('不该回落'),
    })
    eq(hsvCalls, 1, 'HSV 桩调用次数')
    eq(notes, [], '零切点是成功结果，onFallback 不该被调用')
    eq(r.ok, true, '零切点必须 ok=true（与扫描失败 ok:false 语义不同）')
    eq(r.times, [], 'times')
    eq(r.why, '', 'why')
  })

  check("一-4 method='auto'：HSV 成功带切点时直接采用，不回落、times 原样透传", () => {
    const notes = []
    const r = sceneTimes(fakeFile, 0.3, missingBin, {
      method: 'auto',
      hsv: () => HSV_HITS,
      onFallback: (why) => notes.push(why),
    })
    eq(notes, [], '成功路径不许回落')
    eq(r.ok, true, 'ok')
    eq(r.times, HSV_HITS.times, 'times 必须与 HSV 结果逐字一致')
  })

  check('一-5 不传 method 时默认 auto（失败同样回落、同样通知）', () => {
    const notes = []
    const r = sceneTimes(fakeFile, 0.3, missingBin, {
      hsv: () => HSV_FAIL,
      onFallback: (why) => notes.push(why),
    })
    eq(notes.length, 1, '默认方法必须是 auto：回落通知应到一次')
    eq(r.ok, false, 'ok')
  })

  // ══════════════════════ 二、hsvSceneTimes 的分段行为 ══════════════════════
  // 小尺寸 rawvideo：8x4x3 = 96 B/帧，fps=2，chunkSec=2 → 每段 4 帧（+2 帧余量）。
  // 纯色帧之间换色必然触发 16 格全部超阈（th=0.3 → cut=0.15），同色距离为 0。
  const W = 8, H = 4, FPS = 2, CHUNK = 2, TH = 0.3
  const FRAME_SIZE = W * H * 3
  const solid = (r, g, b) => Buffer.from(Array.from({ length: W * H }, () => [r, g, b]).flat())
  const RED = solid(200, 0, 0)
  const BLUE = solid(0, 0, 200)
  const GREEN = solid(0, 200, 0)
  const concat = (...frames) => Buffer.concat(frames)

  /** 从 args 里取 -ss 之后的段起点（首段没有 -ss，按 0）。 */
  const startOf = (args) => {
    const i = args.indexOf('-ss')
    return i >= 0 ? Number(args[i + 1]) : 0
  }
  const baseOpts = { run: null, fps: FPS, width: W, height: H, th: TH, chunkSec: CHUNK }

  check('二-1 跨段切点按全局计时（start + i/fps），且跨段 prev 不断、args/maxBuffer 正确', () => {
    // fps=2 时段0 四帧只覆盖 t=0/0.5/1/1.5；t=2 的切点只能发生在段1 首帧——
    // 它拿段0 最后一帧当比较对象，正好同时验「跨段 prev 保留」与「全局计时」。
    // 段0（start=0，4 帧全红）：无切点。
    // 段1（start=2，4 帧）：蓝 红 红 红
    //   i=0 蓝 vs 上段末帧红 → 切点 t=2+0/2=2（若段内重置，t=0 会被 t>0.2 闸门直接吞掉）
    //   i=1 红 vs 蓝        → 切点 t=2+1/2=2.5（若段内重置，这里会报成 0.5）
    // 段2（start=4）：空 Buffer → 已成功扫过两段，按 EOF 正常结束。
    const segments = new Map([
      [0, concat(RED, RED, RED, RED)],
      [2, concat(BLUE, RED, RED, RED)],
    ])
    const calls = []
    const stats = []
    const run = (bin, args, opts) => {
      const start = startOf(args)
      calls.push({ start, args: [...args], maxBuffer: opts.maxBuffer, encoding: opts.encoding })
      // 夹具纪律：只认 rawvideo 扫描这一种调用形状，参数漂移直接让用例红。
      truthy(args.includes('rawvideo'), 'args 必须要求 rawvideo 输出')
      truthy(args.includes(String(CHUNK)), 'args 必须带 -t chunkSec')
      truthy(opts.encoding === 'buffer', 'runOpts.encoding 必须是 buffer')
      return segments.get(start) ?? Buffer.alloc(0)
    }
    const r = hsvSceneTimes(fakeFile, 'fake-bin', { ...baseOpts, run, onStats: (s) => stats.push(s) })
    eq(r.ok, true, 'ok')
    eq(r.why, '', 'why')
    // 若时间戳按段内重置，段1 首帧切点 t=0 被闸门吞掉、次帧报成 0.5 → 实际只会得到 [0.5]。
    eq(r.times, [2, 2.5], '切点时间戳必须是全局计时')
    eq(calls.map((c) => c.start), [0, 2, 4], '必须按 0 → chunkSec → 2*chunkSec 分三段扫，末段空触发 EOF')
    // 段1 必须带 -ss 2 且 -ss 在 -i 之前（快速 seek 的接线）；首段不许有 -ss。
    eq(calls[0].args.includes('-ss'), false, '首段不许带 -ss')
    const ssIdx = calls[1].args.indexOf('-ss')
    truthy(ssIdx >= 0 && ssIdx < calls[1].args.indexOf('-i'), '非首段必须 -ss 在 -i 之前')
    eq(calls[1].args[ssIdx + 1], '2', '-ss 的值必须是段起点')
    // maxBuffer 按 chunkFrames+2 帧算：(4+2)*96 = 576，三次调用都一样。
    const expectedMax = (Math.ceil(CHUNK * FPS) + 2) * FRAME_SIZE
    truthy(calls.every((c) => c.maxBuffer === expectedMax), `maxBuffer 应恒为 ${expectedMax}`)
    eq(stats.length, 1, 'onStats 恰好回调一次')
    eq(stats[0].chunks, 2, 'onStats.chunks=成功扫过两段')
    eq(stats[0].totalFrames, 8, 'onStats.totalFrames=8')
    truthy(stats[0].maxResidentBytes <= expectedMax, '单段驻留字节不得超过按段算出的 maxBuffer')
  })

  check('二-2 首段就拿到空段（不足一帧）：返回 ok:false，不当作成功', () => {
    const run = () => Buffer.alloc(0)
    const r = hsvSceneTimes(fakeFile, 'fake-bin', { ...baseOpts, run })
    eq(r.ok, false, 'ok')
    eq(r.times, [], 'times')
    truthy(/没拿到一帧完整的 rawvideo/.test(r.why), `why 文案不对：${r.why}`)
  })

  check('二-3 首段返回残帧（长度非整帧、< frameSize）：同样按首段失败处理', () => {
    const run = () => Buffer.alloc(FRAME_SIZE - 1)
    const r = hsvSceneTimes(fakeFile, 'fake-bin', { ...baseOpts, run })
    eq(r.ok, false, '残帧首段必须 ok:false')
    eq(r.times, [], 'times')
  })

  check('二-4 成功扫过至少一段后遇到空段：视为 EOF，ok:true 正常结束', () => {
    let calls = 0
    const run = () => {
      calls++
      // 首段给满 4 帧同色（无切点），第二次 seek 返回空 → EOF
      return calls === 1 ? concat(RED, RED, RED, RED) : Buffer.alloc(0)
    }
    const r = hsvSceneTimes(fakeFile, 'fake-bin', { ...baseOpts, run })
    eq(r.ok, true, '后续空段是 EOF 不是失败')
    eq(r.times, [], '同色片无切点')
    eq(calls, 2, '应当恰好两次 run（一实一空）')
  })

  check('二-5 run 抛错：不向上抛，按 {ok:false} 表达且 why 只带错误码', () => {
    const run = () => { const e = new Error('spawn fake ENOENT'); e.code = 'ENOENT'; throw e }
    const r = hsvSceneTimes(fakeFile, 'fake-bin', { ...baseOpts, run })
    eq(r.ok, false, 'ok')
    eq(r.times, [], 'times')
    truthy(/ENOENT/.test(r.why), `why 必须带错误码：${r.why}`)
    truthy(!r.why.includes('spawn fake'), 'why 不许带原始异常消息（可能含本机路径）')
  })

  check('二-6 没注入 run：直接抛错（本 lib 不自带执行器的契约）', () => {
    throws(() => hsvSceneTimes(fakeFile, 'fake-bin', { fps: FPS, width: W, height: H, chunkSec: CHUNK }),
      /需要 run/, '缺 run 必须抛')
  })

  check('二-7 末段帧数明显不足一整段时提前结束，不多发一次必然为空的 seek', () => {
    // chunkFrames=4，给 2 帧（< 4-1=3）→ 判定末段，循环立即停。
    let calls = 0
    const run = () => { calls++; return concat(RED, BLUE) }
    const r = hsvSceneTimes(fakeFile, 'fake-bin', { ...baseOpts, run })
    eq(calls, 1, '短段即末段，只该有一次 run')
    eq(r.ok, true, 'ok')
    // 切点在 i=1：t = 0 + 1/2 = 0.5，但 t>0.2 闸门保留 0.5
    eq(r.times, [0.5], '短段内切点时间戳')
  })

  // ══════════════════════ 三、framesCacheHit 的复用判据 ══════════════════════
  // 经真实 manifest 落盘/读回构造样例（临时目录，不碰用户缓存）。
  const mdir = join(tmp, 'frames-case')
  mkdirSync(mdir, { recursive: true })
  const writeRead = (info) => {
    writeManifest(mdir, info)
    return readManifest(mdir)
  }
  const base = { ok: true, step: 10, scene: false, times: [10, 20, 30] }
  const m0 = writeRead(base)

  check('三-0 基线：step/scene/times 全一致且有 jpg → 命中（manifest 往返不改变判据）', () => {
    eq(framesCacheHit(m0, 10, false, [10, 20, 30], 5), true, '同参同刻必须命中')
  })

  check('三-1 step 不同 → 不命中', () => {
    eq(framesCacheHit(m0, 20, false, [10, 20, 30], 5), false, 'step 10→20 必须不命中')
  })

  check('三-2 scene 不同 → 不命中', () => {
    eq(framesCacheHit(m0, 10, true, [10, 20, 30], 5), false, 'scene false→true 必须不命中')
  })

  check('三-3 times 不同（at 时刻集合变了）→ 不命中', () => {
    eq(framesCacheHit(m0, 10, false, [10, 20, 99], 5), false, 'times 内容不同必须不命中')
    eq(framesCacheHit(m0, 10, false, [10, 20], 5), false, 'times 长度不同必须不命中')
    eq(framesCacheHit(m0, 10, false, null, 5), false, 'at 集合 vs 非 at 请求必须不命中')
  })

  check('三-4 老 manifest 没有 times 字段：非 at 模式仍命中，at 请求不命中', () => {
    const legacy = writeRead({ ok: true, step: 10, scene: false })
    truthy(!('times' in legacy), '样例前提：老 manifest 确实没有 times 字段')
    eq(framesCacheHit(legacy, 10, false, null, 3), true, '非 at 模式老缓存必须照命中（升级不白抽）')
    eq(framesCacheHit(legacy, 10, false, [460], 3), false, '老 manifest 不得命中 at 请求')
  })

  check('三-5 边界：manifest 未完成/坏、零张 jpg、ok:false 一律不命中', () => {
    eq(framesCacheHit(null, 10, false, null, 5), false, 'null manifest')
    eq(framesCacheHit({ ok: false, step: 10, scene: false, times: null }, 10, false, null, 5), false, 'ok:false')
    eq(framesCacheHit(m0, 10, false, [10, 20, 30], 0), false, '零张 jpg 是残帧，不命中')
    writeFileSync(join(mdir, 'manifest.json'), '{not-json', 'utf8')
    eq(framesCacheHit(readManifest(mdir), 10, false, null, 5), false, '坏 JSON 当作没做完')
  })

  // ══════════════════════ 四、parseAtTimes 的边界 ══════════════════════
  check('四-1 区间起点大于终点必须抛错（秒制与 mm:ss 制都验）', () => {
    throws(() => parseAtTimes('300-100', 936, 5), /区间起点大于终点/, '300-100')
    throws(() => parseAtTimes('13:10-12:30', 936, 5), /区间起点大于终点/, '13:10-12:30')
  })

  check('四-2 非法格式必须抛错', () => {
    throws(() => parseAtTimes('abc', 936, 2), /时间格式错/, 'abc')
    throws(() => parseAtTimes('12:30:99', 936, 2), /时间格式错/, '12:30:99')
    throws(() => parseAtTimes('750,xyz', 936, 2), /时间格式错/, '混合非法片段 750,xyz')
  })

  check('四-3 结果去重 + 升序（乱序、重叠区间、重复单点混合）', () => {
    // 单点乱序 + 重复
    eq(parseAtTimes('750,100,750,100', 936, 2), [100, 750], '单点去重升序')
    // 区间按 step=5 展开 750..760，与区间内单点 755、区间外单点 700 混合
    eq(parseAtTimes('12:30-12:40,755,700', 936, 5), [700, 750, 755, 760], '区间+单点去重升序')
    // 同一时刻的两种写法（750 秒 与 12:30）也必须去重
    eq(parseAtTimes('750,12:30', 936, 2), [750], '等价写法去重')
  })

  check('四-4 正常形状与空输入边界', () => {
    eq(parseAtTimes('750', 936, 2), [750], '单秒点')
    eq(parseAtTimes('12:30', 936, 2), [750], 'mm:ss')
    eq(parseAtTimes('12:30-12:35', 936, 5), [750, 755], '区间按 step 密度')
    eq(parseAtTimes('', 936, 2), null, '空串 → null')
    eq(parseAtTimes(null, 936, 2), null, 'null → null')
  })

  check('四-5 atDirTag：不同时刻集合不同标签、同集合稳定、null 无标签', () => {
    const t460 = atDirTag([460])
    const t750 = atDirTag([750])
    truthy(t460 && t750 && t460 !== t750, '不同时刻集合必须给出不同目录标签')
    eq(atDirTag([460]), t460, '同一集合标签必须稳定（否则缓存永远 miss）')
    eq(atDirTag([460, 750]) === t460, false, '点数/集合不同标签不得撞')
    truthy(/^at-\d+p-[0-9a-f]{8}$/.test(t460), `标签形状 at-Np-<8位hash>，实际 ${t460}`)
    eq(atDirTag(null), null, '非 at 模式返回 null')
    // 点数相同但内容不同（P0 撞目录事故的原型：--at 460 与 --at 750 都是 1p）
    truthy(atDirTag([1]) !== atDirTag([2]), '同点数不同时刻也必须区分')
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ── 汇总 + 退出码：有 FAIL 即非零 ─────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed`)
if (failures) {
  console.log('失败用例：')
  for (const f of fails) console.log(`  - ${f.name}: ${f.msg}`)
  process.exit(1)
}
console.log('ALL GREEN（离线夹具：无 ffmpeg / 无网络 / 无用户缓存目录依赖）')
process.exit(0)
