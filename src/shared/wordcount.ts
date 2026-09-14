// 「约 4 分钟」这类给人看的文案走 i18n（i18n 无任何依赖，引它不会成环；测试默认 zh）
import { t } from '../renderer/i18n'

// 中日韩统一表意文字 + 假名 + 谚文：这些按「字」计，不按空格分词
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g
const LATIN_WORD = /[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*/g

export interface Counts {
  /** 词 = 中日韩字数 + 拉丁词数（中英混排时唯一说得通的口径） */
  words: number
  /** 中日韩字数（含假名 / 谚文） */
  cjk: number
  /** 拉丁词数 */
  latin: number
  /** 字符数，按**码点**算 —— emoji 和生僻字算一个，不是 UTF-16 的两个 */
  chars: number
  /** 字符数（不含任何空白，含标点） */
  charsNoSpace: number
}

/** 文档骨架统计。只有详细统计面板要，别塞进 `count()` 让每节字数白算一遍 */
export interface Shape {
  /** 空行分隔的非空段落数 */
  paragraphs: number
  /** 行数，与 CodeMirror 的 `doc.lines` 同口径（末尾换行后那一行也算） */
  lines: number
}

/**
 * 阅读速度。中文 300 字/分、英文 200 词/分是常见口径；两种文字**各按各的算**再相加，
 * 混排文档才不会因为把汉字当成「词」而把时长估成三倍。
 */
const CJK_PER_MIN = 300
const LATIN_PER_MIN = 200

export function count(text: string): Counts {
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.replace(CJK, ' ').match(LATIN_WORD)?.length ?? 0
  // 空白全是单码元，直接数匹配个数即可；再摊一次 [...text] 在长文上是白花钱
  const spaces = text.match(/\s/g)?.length ?? 0
  const chars = [...text].length
  return { words: cjk + latin, cjk, latin, chars, charsNoSpace: chars - spaces }
}

export function shape(text: string): Shape {
  if (text === '') return { paragraphs: 0, lines: 0 }
  const paragraphs = text.split(/\n[ \t]*\n/).filter((p) => p.trim() !== '').length
  return { paragraphs, lines: text.split('\n').length }
}

/** 估算阅读时长（分钟，可为小数） */
export function readMinutes(c: Counts): number {
  return c.cjk / CJK_PER_MIN + c.latin / LATIN_PER_MIN
}

/** 「约 4 分钟」/「不到 1 分钟」/ 空文档给空串（状态栏上不挂一个没意义的「0 分钟」） */
export function readLabel(c: Counts): string {
  const m = readMinutes(c)
  if (m === 0) return ''
  if (m < 1) return t('wc.lessThan1m')
  return t('wc.minutes', { n: Math.round(m) })
}

/** 千分位。不走 toLocaleString —— 它的结果随运行时的 ICU 变，单测就没法断言了 */
export function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
