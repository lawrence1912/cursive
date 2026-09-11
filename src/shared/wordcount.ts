// 中日韩统一表意文字 + 假名 + 谚文：这些按「字」计，不按空格分词
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g
const LATIN_WORD = /[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*/g

export interface Counts {
  words: number
  chars: number
}

export function count(text: string): Counts {
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.replace(CJK, ' ').match(LATIN_WORD)?.length ?? 0
  return { words: cjk + latin, chars: [...text].length }
}
