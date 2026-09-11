/// <reference types="vite/client" />
import type { CursiveApi } from '../shared/types.js'

declare global {
  interface Window {
    api: CursiveApi
  }
}

export {}
