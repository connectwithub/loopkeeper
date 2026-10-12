export type LogRow = {
  at: number
  kind: string
  where: string
  masked: string
  action: 'blocked' | 'allowed' | 'warned-allowed'
  agentId?: string
}

export type GuardConfig = {
  deny: string[]
  warn: string[]
  publicPaths: string[] | null
  allowPaths: string[]
  disabledKinds: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'lk-secret-guard': {
      enabled: boolean
      band: boolean
      log: LogRow[]
      blocked: number
      allowed: number
      config: GuardConfig | null
      configFiles: string[]
      configErrors: string[]
    }
  }
}
