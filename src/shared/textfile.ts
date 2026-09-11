/**
 * 磁盘上的字节 ↔ 编辑器里的文本。
 *
 * CodeMirror 建 state 时会用 /\r\n?|\n/ 切行，CRLF 和单 CR 都会被归一成 LF；
 * BOM 若不剥掉则会当成正文第一个字符（`﻿# 标题` 就不再是标题了）。
 * 两者都会破坏「保存零损耗」，所以在读的时候把它们摘成指纹，写回时原样还原。
 */

export type Eol = '\n' | '\r\n' | '\r'

export interface FileFingerprint {
  eol: Eol
  bom: boolean
}

export const DEFAULT_FINGERPRINT: FileFingerprint = { eol: '\n', bom: false }

export interface DecodedFile {
  /** 已剥掉 BOM、换行归一为 LF —— 直接可以喂给 CodeMirror */
  text: string
  fingerprint: FileFingerprint
}

function detectEol(raw: string): Eol {
  const crlf = raw.match(/\r\n/g)?.length ?? 0
  const lf = raw.match(/(?<!\r)\n/g)?.length ?? 0
  const cr = raw.match(/\r(?!\n)/g)?.length ?? 0
  if (crlf === 0 && lf === 0 && cr === 0) return '\n'
  if (crlf >= lf && crlf >= cr) return '\r\n'
  if (cr > lf) return '\r'
  return '\n'
}

export function decode(raw: string): DecodedFile {
  const bom = raw.charCodeAt(0) === 0xfeff
  const body = bom ? raw.slice(1) : raw
  const eol = detectEol(body)
  return {
    text: eol === '\n' ? body : body.replace(/\r\n?/g, '\n'),
    fingerprint: { eol, bom }
  }
}

export function encode(text: string, fingerprint: FileFingerprint): string {
  const { eol, bom } = fingerprint
  const body = eol === '\n' ? text : text.replace(/\n/g, eol)
  return bom ? `﻿${body}` : body
}
