import Store from 'electron-store'

interface Schema {
  recentFiles: string[]
  windowBounds: { width: number; height: number; x?: number; y?: number }
  lastFolder: string | null
}

export const store = new Store<Schema>({
  defaults: {
    recentFiles: [],
    windowBounds: { width: 1100, height: 780 },
    lastFolder: null
  }
})

const MAX_RECENT = 12

export function getRecent(): string[] {
  return store.get('recentFiles')
}

export function pushRecent(path: string): string[] {
  const next = [path, ...store.get('recentFiles').filter((p) => p !== path)].slice(0, MAX_RECENT)
  store.set('recentFiles', next)
  return next
}

export function clearRecent(): string[] {
  store.set('recentFiles', [])
  return []
}
