export type SettingFieldType = 'text' | 'secret' | 'toggle'

export type SettingField = { key: string; label: string; type: SettingFieldType; help?: string }

export type SessionKind = 'chat' | 'terminal'

export type PluginPermissions = { network?: string[]; sessions?: SessionKind[]; settings?: boolean }

export type TaskContext = { name: string; markdown: string }

export type SessionRequest = { title: string; cwd: string; context?: TaskContext; prompt?: string }

export type ThemeName = 'light' | 'dark'

export type ToastKind = 'info' | 'error'

export type SettingsView = { fields: SettingField[]; values: Record<string, string>; configured: Record<string, boolean> }

export type ScreenApi = {
  call(method: string, params?: unknown): Promise<unknown>
  sessions: {
    startChat(req: SessionRequest): Promise<void>
    startTerminal(req: SessionRequest): Promise<void>
  }
  settings: {
    view(): Promise<SettingsView>
    set(key: string, value: string | null): Promise<void>
  }
  folders: { recent(): Promise<string[]> }
  ui: { toast(text: string, kind?: ToastKind): Promise<void> }
  theme(): Promise<ThemeName>
  onTheme(cb: (theme: ThemeName) => void): Promise<void>
}

export type PluginRequirement = { id: string; version?: string }

export type RequirementContributions = { agents?: string[]; skills?: string[]; flows?: string[] }

type RequirementHead = { id: string; minVersion?: string }

export type RequirementStep =
  | (RequirementHead & { status: 'ok'; installedVersion: string })
  | (RequirementHead & { status: 'enable'; installedVersion: string; name: string })
  | (RequirementHead & {
    status: 'install' | 'update'
    installedVersion?: string
    listing: { repo: string; ref: string; marketplace: string }
    preview: { manifest: { id: string; name: string; version: string }; commit: string; permissions: PluginPermissions; runtime: 'trusted' | 'isolated'; contributes?: RequirementContributions }
  })
  | (RequirementHead & { status: 'unavailable'; reason: string })

export type InstalledPlugin = {
  id: string
  name: string
  version: string
  description: string
  runtime: 'trusted' | 'isolated'
  source: { repo: string; ref: string; marketplace?: string }
  commit: string
  permissions: PluginPermissions
  settingsFields?: SettingField[]
  icon?: string
  server?: string
  screen?: string
  queueSource?: true
  requires?: PluginRequirement[]
  enabled: boolean
  restartRequired?: boolean
  installedAt: string
  updatedAt: string
}

export type CatalogPlugin = { id: string; repo: string; ref: string; name: string; description: string; runtime: 'trusted' | 'isolated' }

export type CatalogEntry =
  | { marketplace: string; name: string | null; plugins: CatalogPlugin[]; skipped: Array<{ id: string | null; reason: string }> }
  | { marketplace: string; error: string }
