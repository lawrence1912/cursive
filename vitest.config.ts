import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * **测试文件串行跑**（0.2.0 改）。慢，但换来确定性。
     *
     * 有两条测试天生吃机器负载，因为它们量的就是 lezer 的**挂钟时间预算**：
     * - `block.test.ts` 的「首开长文档：表格不因半截树被截断」——
     *   名字里就写着「不预先 ensure，复刻打开文件」，树解析到哪儿算哪儿；
     * - `code.test.ts` 的 `ensureSyntaxTree(state, len, 5000)`，5000 是毫秒不是字符数。
     *
     * 并行跑时它们和别的文件抢 CPU，机器一忙就随机变红（实测：拿 6 个满载进程压着，
     * 三次里必有一次）。而 `release.sh` 是「测试全绿才出包」——
     * 一条随机红的测试会把发布卡住，而且每次都得先花十分钟确认「这次是不是真的坏了」。
     *
     * 代价是整套从 ~2.5s 变成 ~7.5s。这点时间比一次误报便宜得多。
     * 想换回并行，删掉这一行即可（那两条测试的时间敏感性是它们自己的设计，不是 bug）。
     */
    fileParallelism: false
  }
})
