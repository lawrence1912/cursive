/// <reference types="vite/client" />
import type { CursiveApi, DocPayload } from '../shared/types.js'

declare global {
  interface Window {
    api: CursiveApi

    /**
     * 契约 v18（P4-6①，启动文档注入）—— **单向、只在启动那一刻存在**。
     * 壳在 `atDocumentStart` 注进来的那份文档（argv / Finder 双击打开的那个文件），
     * 先于页面的模块脚本，所以 `main.ts` 一跑就能拿到，不必「等就绪 → 一趟 IPC」。
     * 没有文件（新建窗口 / 双击 app 图标）或读盘失败时**这个属性根本不存在** ——
     * 后一种情况壳会退回老路（就绪后 `file:opened`），两条路不会同时发生。
     */
    __cursiveInitialDoc?: DocPayload

    /**
     * 计时探针（P4-6）：壳**只在 `CURSIVE_TIMING=1` 下**才注入这个函数，
     * 平时它不存在 —— 调用处一律 `window.__cursiveMark?.(…)`，正常启动零开销。
     * 壳侧的 `mark()` 全都停在「文档推给渲染层」之前，而启动速度真正的终点
     * （模块开跑 / 文档进编辑器 / 文档上屏）只有页面自己知道。
     */
    __cursiveMark?: (label: string) => void

    /**
     * 契约 v24（自检标记）—— 壳**只在 `CURSIVE_SMOKE` 自检下**注入，平时不存在。
     * 渲染层据此关掉一切「把上次的样子恢复出来」的行为（现在是会话恢复，见
     * `ui/session.ts`）：自检要的是一个**确定的**起点，而恢复出来的标签会让
     * 「开了几个标签 / 大纲几行 / 快速打开列几个文件」这类断言随上一轮的残留而飘。
     */
    __cursiveSelfCheck?: boolean
  }
}

export {}
