/// <reference types="vite/client" />
import type { TypmdApi } from '../shared/types.js'

declare global {
  interface Window {
    api: TypmdApi
  }
}

export {}
