import { describe, expect, it } from 'vitest'
import { compareVersions, verdict } from '../src/renderer/ui/update'
import type { UpdateInfo } from '../src/shared/types'

/**
 * 检查更新（0.3.0 T2）里**能错的那一半**。
 *
 * 联网、菜单、状态栏那几步都在别处验（壳侧 `checkUpdate` + `release.sh` 的 E2E）；
 * 这里只盯两个纯函数 —— 而这条路上所有「说错话」的方式恰好都住在它们里面：
 * 版本比反了、认不出的 tag 被当成「已是最新」、预发布被当成正式版。
 */
describe('版本比大小', () => {
  it('按段比数值，不是比字符串', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('0.10.0 比 0.9.0 新 —— 字符串比会比反的那一对', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
  })

  it('tag 上的 v 前缀两边都认', () => {
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0)
    expect(compareVersions('V0.3.0', 'v0.2.0')).toBeGreaterThan(0)
  })

  it('缺的段当 0（GitHub 上写成 v0.3 的 tag 不少见）', () => {
    expect(compareVersions('0.3', '0.3.0')).toBe(0)
    expect(compareVersions('1', '0.9.9')).toBeGreaterThan(0)
  })

  it('构建元数据不参与比较（semver 10）', () => {
    expect(compareVersions('0.3.0+build.7', '0.3.0+build.8')).toBe(0)
  })

  it('预发布排在正式版前面 —— 比反了就会在正式版上被劝更新', () => {
    expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBeGreaterThan(0)
  })

  it('两个预发布之间：逐段比，数字段按数值且排在字母段前面', () => {
    expect(compareVersions('0.3.0-rc.2', '0.3.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0-rc.10', '0.3.0-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0-alpha', '0.3.0-beta')).toBeLessThan(0)
    // 段数少的在前（前缀相同时）
    expect(compareVersions('0.3.0-rc', '0.3.0-rc.1')).toBeLessThan(0)
    // 纯数字段比带字母的段低
    expect(compareVersions('0.3.0-1', '0.3.0-alpha')).toBeLessThan(0)
  })

  it('认不出来的回 null，而不是硬比一个数出来', () => {
    expect(compareVersions('nightly', '0.2.0')).toBeNull()
    expect(compareVersions('0.3.0', 'latest')).toBeNull()
    expect(compareVersions('', '0.2.0')).toBeNull()
    // 四段不是 semver —— 认了反而会把 `0.3.0.1` 与 `0.3.0` 比出先后
    expect(compareVersions('0.3.0.1', '0.3.0')).toBeNull()
  })
})

const RELEASES = 'https://github.com/lawrence1912/cursive/releases/latest'
const info = (latest: string | null, current: string): UpdateInfo => ({ latest, current, url: RELEASES })

describe('该说哪一句', () => {
  it('壳没问着 → unknown（状态栏那句是黄的）', () => {
    expect(verdict(null)).toEqual({ kind: 'unknown' })
  })

  it('那边还没发过 release（壳把 404 翻成 latest: null）→ none，不是 unknown', () => {
    // 「没问着」与「问着了、那边还没发过版本」该说的话不一样：
    // 前者要黄色地说「连不上 GitHub」，后者什么都没出错。这个仓库在第一次发版之前
    // 一直是后者，而把它说成前者就是在冤枉网络
    expect(verdict(info(null, '0.2.0'))).toEqual({ kind: 'none' })
  })

  it('tag 认不出来 → 也是 unknown，**不许**当成「已是最新」', () => {
    // 把认不出的当成「已是最新」是最坏的一种错：它看起来一切正常，
    // 而用户从此再也收不到更新提示
    expect(verdict(info('nightly-2026-09-20', '0.2.0'))).toEqual({ kind: 'unknown' })
  })

  it('有新版本：两个号都剥掉 v，去处原样带走', () => {
    expect(verdict(info('v0.3.0', '0.2.0'))).toEqual({
      kind: 'newer',
      latest: '0.3.0',
      current: '0.2.0',
      url: RELEASES
    })
  })

  it('一样新 → 已是最新', () => {
    expect(verdict(info('v0.2.0', '0.2.0'))).toEqual({ kind: 'current', version: '0.2.0' })
  })

  it('本机比发布的还新（跑着没发布的构建）→ 也说「已是最新」', () => {
    // 「你比最新的还新」对用户不是一条有用的消息
    expect(verdict(info('v0.2.0', '0.3.0'))).toEqual({ kind: 'current', version: '0.3.0' })
  })

  it('开发构建（读不到 Info.plist，壳回 0.0.0）→ 任何 release 都算新', () => {
    expect(verdict(info('v0.2.0', '0.0.0'))).toMatchObject({ kind: 'newer', latest: '0.2.0' })
  })

  it('正式版对上一条 rc：不劝退回去', () => {
    expect(verdict(info('v0.3.0-rc.1', '0.3.0'))).toEqual({ kind: 'current', version: '0.3.0' })
    expect(verdict(info('v0.3.0', '0.3.0-rc.1'))).toMatchObject({ kind: 'newer', latest: '0.3.0' })
  })
})
