import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentConnection } from '../server/agent-connections'
import type { DiscoveryState } from '../server/model-discovery'
import { discoveryLine, modelsLabel } from './connection-models'
import type { WorkflowNode } from '../server/workflows'
import { normalizeUsage, weeklyOnly, type ProviderUsage, type QuotaWindow } from './provider-usage'
import { readRecord } from './shared'
import { api, apiDelete } from './studio-api'
import { BUILTIN_ROLES, roleOptions, roleWord, rolesBody, validRoleName, type RoleAssignment, type RoleOption } from './studio-graph'
import { DISARM_MS } from './confirm-button'

export type ConnectionList = { builtins: string[]; connections: AgentConnection[]; presets: Array<Partial<AgentConnection>>; models: Record<string, string[]>; roles?: Record<string, { engine: string; model: string | null }>; discovery?: Record<string, DiscoveryState | null> }
type Choice = { kind: 'builtin'; id: string } | { kind: 'connection'; value: AgentConnection } | { kind: 'preset'; value: Partial<AgentConnection> } | { kind: 'presets' }
type SecretsView = { zaiBaseUrl: string; zaiAuthTokenConfigured: boolean }

const BUILTIN: Record<string, { name: string; line: string; description: string }> = {
  claude: { name: 'Claude', line: 'Claude Code CLI', description: 'Uses the account signed in through the Claude Code CLI on this machine.' },
  codex: { name: 'Codex', line: 'Codex CLI', description: 'Uses the account signed in through the Codex CLI on this machine.' },
  glm: { name: 'GLM', line: 'Claude Code through z.ai', description: 'Runs Claude Code against your z.ai account. Set the base URL and token here.' },
}
const Icon = ({ id }: { id: string }) => <svg aria-hidden="true"><use href={`#${id}`} /></svg>

function GlmSettings({ report, onError }: { report: (text: string) => void; onError: (text: string) => void }) {
  const [view, setView] = useState<SecretsView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => { const response = await fetch('/api/secrets'); const data = await response.json() as SecretsView & { error?: string }; if (!response.ok) throw new Error(data.error ?? 'Could not read the z.ai settings'); setView(data); setBaseUrl(data.zaiBaseUrl) }
  useEffect(() => { void load().catch(error => onError((error as Error).message)) }, [])
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      const response = await fetch('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zaiBaseUrl: baseUrl, ...(token.trim() ? { zaiAuthToken: token } : {}) }) })
      const data = await response.json() as SecretsView & { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Could not save')
      setView(data); setToken(''); report('z.ai settings saved.')
    } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  return <form className="field-stack" onSubmit={save}>
    <label>Z.ai base URL<input type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
    <label>Z.ai token<input type="password" autoComplete="off" value={token} placeholder={view?.zaiAuthTokenConfigured ? 'Configured · type to replace' : 'Paste your z.ai token'} onChange={event => setToken(event.target.value)} /></label>
    <p className="muted connection-small">The token is stored on this machine only and never shown again.</p>
    <button className="connection-button primary" type="submit" disabled={busy || !view}>Save</button>
  </form>
}

type NotifyView = { notifyWebhookUrl: string | null; notifyWebhookKeyConfigured: boolean }

function NotifySettings({ report, onError }: { report: (text: string) => void; onError: (text: string) => void }) {
  const [view, setView] = useState<NotifyView | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = (data: NotifyView) => { setView(data); setUrl(data.notifyWebhookUrl ?? '') }
  useEffect(() => { void fetch('/api/secrets').then(response => response.json() as Promise<NotifyView>).then(apply).catch(error => onError((error as Error).message)) }, [])
  const send = async (patch: Record<string, unknown>, done: string) => {
    setBusy(true)
    try {
      const response = await fetch('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      const data = await response.json() as NotifyView & { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Could not save')
      apply(data); setKey(''); report(done)
    } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  const save = (event: React.FormEvent) => { event.preventDefault(); void send({ ...(url.trim() ? { notifyWebhookUrl: url } : {}), ...(key.trim() ? { notifyWebhookKey: key } : {}) }, 'Webhook settings saved.') }
  return <section className="connection-settings" aria-labelledby="notify-title">
    <header><h2 id="notify-title">Webhook</h2><p className="muted connection-small">Tell a bot on another machine whenever a queue card needs a person.</p></header>
    <form className="field-stack" onSubmit={save}>
      <label>Webhook URL<input type="url" pattern="https://.*" value={url} placeholder="https://bot.example.com/hook" onChange={event => setUrl(event.target.value)} /></label>
      <label>Webhook key<input type="password" autoComplete="off" value={key} placeholder={view?.notifyWebhookKeyConfigured ? 'Configured · type to replace' : 'Shared key the bot checks'} onChange={event => setKey(event.target.value)} /></label>
      <p className="muted connection-small">Sent as a Bearer token and X-Automation-Key. The key stays on this machine and is never shown again.</p>
      <div className="connection-foot"><button className="connection-button primary" type="submit" disabled={busy || !view}>Save</button><button type="button" className="connection-button" disabled={busy || !view} onClick={() => void send({ notifyWebhookUrl: null, notifyWebhookKey: null }, 'Webhook cleared.')}>Clear</button></div>
    </form>
  </section>
}

const ENGINE_TINTS: Record<string, string> = { claude: '#d4a091', glm: '#91b0dc', codex: '#bfd38b' }
const LOGOS = new Set(['claude', 'glm', 'codex', 'qwen', 'grok'])
type Details = { usage: Record<string, unknown>; roles: Record<string, unknown>; models: Record<string, string[]>; glmConfigured: boolean }
const adapterLine = (adapter: AgentConnection['adapter'] | undefined) => adapter === 'cli' ? 'Headless CLI' : adapter === 'opencode' ? 'OpenCode' : 'ACP agent'
const tint = (id: string) => ({ '--engine': ENGINE_TINTS[id] ?? 'var(--line)' }) as CSSProperties

function Logo({ id, size }: { id: string; size: number }) {
  return <span className="connection-logo" style={{ ...tint(id), '--s': `${size}px` } as CSSProperties}>{LOGOS.has(id) ? <img src={`/providers/${id}.svg`} alt="" /> : <Icon id="auto-icon" />}</span>
}

function UsageBars({ usage }: { usage: ProviderUsage }) {
  const windows: Array<[string, QuotaWindow]> = weeklyOnly(usage.provider) ? [['Weekly', usage.weekly]] : [['5h', usage.fiveHour], ['Weekly', usage.weekly]]
  return <>{windows.map(([label, window]) => <div className="connection-bar" key={label} title={window.reset ? `Resets ${window.reset}` : usage.reason || undefined}><span>{label}</span><i><b style={{ width: `${window.percent ?? 0}%` }} /></i><em>{window.percent === null ? '—' : `${Math.round(window.percent)}%`}</em></div>)}</>
}

function ConfirmRemove({ label, busy, warning, onConfirm }: { label: string; busy: boolean; warning: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), DISARM_MS)
    return () => clearTimeout(timer)
  }, [armed])
  return <button type="button" className="confirm-morph" data-armed={armed} disabled={busy} aria-label={armed ? 'Remove: click again to confirm' : label} title={armed ? `Click again to remove. ${warning}` : warning} onBlur={() => setArmed(false)} onMouseLeave={() => setArmed(false)} onKeyDown={(event) => { if (event.key === 'Escape') setArmed(false) }} onClick={() => { if (!armed) { setArmed(true); return } setArmed(false); onConfirm() }}><span>{label}</span><span>Remove</span></button>
}

function ModelDiscoveryLine({ adapter, state, checking, onRefresh }: { adapter: AgentConnection['adapter'] | undefined; state: DiscoveryState | null | undefined; checking: boolean; onRefresh: () => void }) {
  const line = discoveryLine(adapter, state, Date.now())
  return <p className="muted connection-small connection-discovery" data-state={state?.error ? 'error' : undefined}><span>{line.text}</span>{line.refresh && <button type="button" className="connection-button connection-refresh" disabled={checking} onClick={onRefresh}><Icon id="history-icon" />{checking ? 'Checking…' : 'Refresh'}</button>}</p>
}

type AiChoice = { id: string; name: string }
const readFallback = (value: unknown): RoleAssignment | null => { const entry = readRecord(value); return typeof entry.engine === 'string' && entry.engine ? { engine: entry.engine, model: typeof entry.model === 'string' ? entry.model : null } : null }

function AiSelect({ label, value, ais, off, onChange }: { label: string; value: string; ais: readonly AiChoice[]; off?: boolean; onChange: (engine: string) => void }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
    {off && <option value="">Off</option>}
    {ais.map(ai => <option key={ai.id} value={ai.id}>{ai.name}</option>)}
    {value && !ais.some(ai => ai.id === value) && <option value={value}>Unavailable · {value}</option>}
  </select>
}

function ModelInput({ label, id, value, models, disabled, onChange }: { label: string; id: string; value: string | null; models: readonly string[]; disabled?: boolean; onChange: (model: string | null) => void }) {
  return <><input aria-label={label} list={id} value={value ?? ''} disabled={disabled} placeholder="This AI's default" onChange={event => onChange(event.target.value.trim() ? event.target.value : null)} /><datalist id={id}>{models.map(model => <option key={model} value={model} />)}</datalist></>
}

function RolesSettings({ read, ais, models, onSaved }: { read: Record<string, unknown>; ais: readonly AiChoice[]; models: Record<string, string[]>; onSaved: (saved: Record<string, unknown>) => void }) {
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [fallback, setFallback] = useState<RoleAssignment | null>(null)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState('')
  const [status, setStatus] = useState<{ saved: true } | { error: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setRoles(roleOptions(read)); setFallback(readFallback(read.fallback)) }, [read])
  const edit = (name: string, patch: Partial<RoleAssignment>) => { setRoles(current => current.map(role => role.name === name ? { ...role, ...patch } : role)); setStatus(null) }
  const add = () => {
    const name = newName.trim()
    const names = roles.map(role => role.name)
    if (!validRoleName(name, names)) { setNameError(names.includes(name) ? `A role named ${name} already exists.` : 'Use up to 64 letters, numbers, - or _, starting with a letter or number. autoReview and fallback are taken.'); return }
    setRoles([...roles, { name, engine: roles.find(role => role.name === 'execute')?.engine ?? ais[0]?.id ?? '', model: null }]); setNewName(''); setNameError(''); setStatus(null)
  }
  const save = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/roles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rolesBody(read, roles, fallback)) })
      const data = readRecord(await response.json().catch(() => ({})))
      if (!response.ok) { setStatus({ error: typeof data.error === 'string' ? data.error : `Could not save the roles (${response.status})` }); return }
      setStatus({ saved: true }); onSaved(data)
    } catch (error) { setStatus({ error: (error as Error).message }) } finally { setBusy(false) }
  }
  return <section className="connection-settings roles-settings" aria-labelledby="roles-title">
    <header><h2 id="roles-title">Roles</h2><p className="muted connection-small">Each flow step names a role. Pick the AI and model that plays it.</p></header>
    <div className="role-rows">
      {roles.map(role => <div className="role-row" key={role.name}>
        <strong>{roleWord(role.name)}</strong>
        <AiSelect label={`AI for ${roleWord(role.name)}`} value={role.engine} ais={ais} onChange={engine => edit(role.name, { engine })} />
        <ModelInput label={`Model for ${roleWord(role.name)}`} id={`role-models-${role.name}`} value={role.model} models={models[role.engine] ?? []} onChange={model => edit(role.name, { model })} />
        {(BUILTIN_ROLES as readonly string[]).includes(role.name) ? <span /> : <button type="button" className="connection-button" aria-label={`Remove role ${roleWord(role.name)}`} onClick={() => { setRoles(roles.filter(item => item.name !== role.name)); setStatus(null) }}>Remove</button>}
      </div>)}
      <form className="role-row role-add" onSubmit={event => { event.preventDefault(); add() }}>
        <input aria-label="New role name" value={newName} placeholder="builder" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? 'role-name-error' : undefined} onChange={event => { setNewName(event.target.value); setNameError('') }} />
        <button type="submit" className="connection-button" disabled={!newName.trim()}><Icon id="plus-icon" />Add role</button>
        {nameError && <p id="role-name-error" role="alert" className="chat-error">{nameError}</p>}
      </form>
    </div>
    <div className="role-row role-fallback">
      <strong>Fallback AI</strong>
      <AiSelect label="Fallback AI" value={fallback?.engine ?? ''} ais={ais} off onChange={engine => { setFallback(engine ? { engine, model: fallback?.engine === engine ? fallback.model : null } : null); setStatus(null) }} />
      <ModelInput label="Fallback model" id="fallback-models" value={fallback?.model ?? null} models={fallback ? models[fallback.engine] ?? [] : []} disabled={!fallback} onChange={model => { if (fallback) { setFallback({ ...fallback, model }); setStatus(null) } }} />
      <p className="muted connection-small">Takes over when a step's AI cannot start or keeps crashing.</p>
    </div>
    <div className="connection-foot">
      <button type="button" className="connection-button primary" disabled={busy} onClick={() => void save()}>Save roles</button>
      {status && ('saved' in status ? <span className="muted connection-small" role="status">Saved</span> : <p role="alert" className="chat-error">{status.error}</p>)}
    </div>
  </section>
}

export function Connections({ list, refresh, report, onError, onConnect }: { list: ConnectionList; refresh: () => Promise<void>; report: (text: string) => void; onError: (text: string) => void; onConnect?: () => void }) {
  const [choice, setChoice] = useState<Choice>({ kind: 'builtin', id: 'claude' })
  const [editing, setEditing] = useState<Partial<AgentConnection>>({})
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [terminalArgs, setTerminalArgs] = useState('')
  const [probe, setProbe] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [details, setDetails] = useState<Details>({ usage: {}, roles: {}, models: {}, glmConfigured: true })
  useEffect(() => {
    let cancelled = false
    const read = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error(`Could not read ${url}`); return await response.json() as Record<string, never> }
    Promise.all(['/api/quota', '/api/roles', '/api/models', '/api/secrets'].map(read))
      .then(([usage, roles, models, secrets]) => { if (!cancelled) setDetails({ usage: usage!, roles: roles!, models: models!, glmConfigured: readRecord(secrets).zaiAuthTokenConfigured === true }) })
      .catch(error => { if (!cancelled) onError((error as Error).message) })
    return () => { cancelled = true }
  }, [list])
  const select = (value: Partial<AgentConnection>) => { setEditing({ ...value }); setArgs((value.args ?? []).join('\n')); setEnv(Object.entries(value.env ?? {}).map(([key, reference]) => `${key}=${reference}`).join('\n')); setTerminalArgs(value.terminalArgs ? value.terminalArgs.join('\n') : ''); setProbe(''); setAdvanced(!value.command) }
  const pick = (next: Choice) => { setChoice(next); if (next.kind === 'connection' || next.kind === 'preset') select(next.value) }
  const configured = choice.kind === 'connection'
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      const references = Object.fromEntries(env.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [key, reference, extra] = line.split('='); if (!key || !reference || extra) throw new Error('Use TARGET_ENV=SOURCE_ENV, one per line'); return [key.trim(), reference.trim()] }))
      const saved = await api<AgentConnection>('/connections', { ...editing, models: (editing.models ?? []).map(model => model.trim()).filter(Boolean), args: args.split('\n').filter(Boolean), env: references, terminalArgs: terminalArgs ? terminalArgs.split('\n').filter(Boolean) : editing.terminalArgs !== undefined ? [] : undefined })
      pick({ kind: 'connection', value: saved }); await refresh(); report('AI connection saved. Sign in to its app before running it.'); onConnect?.()
      if (saved.adapter !== 'cli') void refreshModels(saved.id)
    } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  const check = async () => { setBusy(true); try { setProbe(JSON.stringify(await api(`/connections/${editing.id}/probe`, {}), null, 2)); report('Connection checked. No task was sent.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) } }
  const refreshModels = async (id = editing.id) => {
    setChecking(true)
    try {
      const state = await api<DiscoveryState>(`/connections/${id}/models/refresh`, {})
      await refresh()
      if (state.error) onError(`Couldn't list models: ${state.error}`)
      else report(`Found ${state.models.length} model${state.models.length === 1 ? '' : 's'}.`)
    } catch (error) { onError((error as Error).message) } finally { setChecking(false) }
  }
  const remove = async () => { setBusy(true); try { await apiDelete(`/connections/${editing.id}`); await refresh(); pick({ kind: 'builtin', id: 'claude' }); report('Connection removed.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) } }
  const current = (test: (item: Choice) => boolean) => test(choice)
  const aiId = choice.kind === 'builtin' ? choice.id : choice.kind === 'presets' ? '' : editing.id ?? ''
  const usedFor = roleOptions(details.roles).filter(role => role.engine === aiId).map(role => role.name)
  const ais: AiChoice[] = [...list.builtins.map(id => ({ id, name: BUILTIN[id]?.name ?? id })), ...list.connections.map(connection => ({ id: connection.id, name: connection.name }))]
  const models = choice.kind === 'builtin' ? details.models[aiId] ?? [] : configured ? list.models[aiId] ?? details.models[aiId] ?? [] : (editing.models ?? []).filter(Boolean)
  const header = choice.kind === 'builtin'
    ? { name: BUILTIN[choice.id]?.name ?? choice.id, line: BUILTIN[choice.id]?.line ?? 'Built in', description: BUILTIN[choice.id]?.description ?? 'Built-in integration.' }
    : { name: editing.name || 'New connection', line: `${adapterLine(editing.adapter)}${configured ? '' : ' · not saved yet'}`, description: 'Install the app and sign in, then check the connection. Advanced settings are below.' }

  return <section className="studio-view connections-view">
    <RolesSettings read={details.roles} ais={ais} models={{ ...details.models, ...list.models }} onSaved={saved => { setDetails(current => ({ ...current, roles: saved })); void refresh() }} />
    <NotifySettings report={report} onError={onError} />
    <aside className="connection-list" aria-label="AI connections">
      <h2>AIs <span className="muted">{list.builtins.length + list.connections.length} connected</span></h2>
      {list.builtins.map(id => <button key={id} type="button" className="connection-choice" aria-pressed={current(item => item.kind === 'builtin' && item.id === id)} onClick={() => pick({ kind: 'builtin', id })}><Logo id={id} size={28} /><span><strong>{BUILTIN[id]?.name ?? id}</strong><small>{BUILTIN[id]?.line ?? 'Built in'}</small></span><i className="connection-dot" /></button>)}
      {list.connections.map(connection => <button key={connection.id} type="button" className="connection-choice" aria-pressed={current(item => item.kind === 'connection' && item.value.id === connection.id)} onClick={() => pick({ kind: 'connection', value: connection })}><Logo id={connection.id} size={28} /><span><strong>{connection.name}</strong><small>{adapterLine(connection.adapter)}</small></span><i className="connection-dot" /></button>)}
      <button type="button" className="connection-add" aria-pressed={current(item => item.kind === 'presets' || item.kind === 'preset')} onClick={() => pick({ kind: 'presets' })}><Icon id="plus-icon" />Add an AI</button>
    </aside>
    {choice.kind === 'presets' ? <div className="connection-settings"><header><h2>Add an AI</h2><p className="muted connection-small">Choose the app you already use. Install it and sign in, then check the connection.</p></header>
      <div className="preset-list">{list.presets.map(preset => <button key={preset.id} type="button" className="preset-row" onClick={() => pick({ kind: 'preset', value: preset })}><span><strong>{preset.name}</strong><small>{preset.adapter === 'cli' ? 'Headless CLI with a {{prompt}} slot' : preset.adapter === 'opencode' ? 'OpenCode · API or local models' : preset.command ? `ACP agent · ${preset.command}` : 'ACP agent · your own command'}</small></span><Icon id="plus-icon" /></button>)}</div></div>
    : <div className="connection-settings" style={tint(aiId)}>
      <header className="connection-head"><Logo id={aiId} size={40} /><div><h2>{header.name}</h2><p className="muted">{header.line}</p></div>{(choice.kind === 'builtin' || configured) && (aiId === 'glm' && !details.glmConfigured ? <span className="connection-ready" data-state="setup">Needs setup</span> : <span className="connection-ready">Ready</span>)}</header>
      <p className="connection-note">{header.description}</p>
      <div className="connection-columns">
        <div className="connection-section"><h3>Usage</h3><UsageBars usage={normalizeUsage(aiId, details.usage[aiId])} /></div>
        <div className="connection-section"><h3>Used for</h3>{usedFor.length ? usedFor.map(role => <span className="connection-role" key={role}>{roleWord(role)}</span>) : <span className="muted connection-small">Not assigned</span>}<p className="muted connection-small">Change in Roles above</p></div>
      </div>
      {(models.length > 0 || configured) && <div className="connection-section"><h3>Models</h3>{models.length > 0 && <div>{models.map(model => <span className="connection-chip" key={model}>{model}</span>)}</div>}{configured && <ModelDiscoveryLine adapter={editing.adapter} state={list.discovery?.[aiId]} checking={checking} onRefresh={() => void refreshModels()} />}</div>}
      {choice.kind === 'builtin' && choice.id === 'glm' && <div className="connection-section"><h3>z.ai settings</h3><GlmSettings report={report} onError={onError} /></div>}
      {choice.kind !== 'builtin' && <form className="connection-section field-stack" onSubmit={save}><h3>Connection settings</h3>
        <label>Name<input required value={editing.name ?? ''} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
        <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>Advanced connection settings</summary>
          <label>Connection ID<input required value={editing.id ?? ''} disabled={configured} onChange={event => setEditing({ ...editing, id: event.target.value })} /></label>
          <label>Adapter<select value={editing.adapter ?? 'acp'} onChange={event => setEditing({ ...editing, adapter: event.target.value as AgentConnection['adapter'] })}><option value="acp">ACP coding agent</option><option value="opencode">OpenCode · API / local models</option><option value="cli">Headless CLI</option></select></label>
          <label>Executable<input required value={editing.command ?? ''} placeholder="qwen" onChange={event => setEditing({ ...editing, command: event.target.value })} /></label>
          <label>Arguments · one per line<textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} /><small className="muted">CLI slots: {'{{prompt}}'}, {'{{model}}'}, {'{{session}}'}. Arguments are passed directly, without a shell.</small></label>
          <label>{modelsLabel(editing.adapter)}<textarea rows={3} value={(editing.models ?? []).join('\n')} onChange={event => setEditing({ ...editing, models: event.target.value.split('\n') })} /></label>
          <label>Model family<input value={editing.family ?? ''} placeholder="qwen, grok, llama…" onChange={event => setEditing({ ...editing, family: event.target.value || undefined })} /><small className="muted">Used for the cross-family review when a model ID has no recognized family.</small></label>
          {editing.adapter === 'opencode' && <><label>Base URL (optional)<input type="url" value={editing.baseUrl ?? ''} placeholder="http://localhost:11434/v1" onChange={event => setEditing({ ...editing, baseUrl: event.target.value || undefined })} /></label><label>Provider ID<input value={editing.provider ?? 'custom'} onChange={event => setEditing({ ...editing, provider: event.target.value })} /></label><label>API key environment variable<input value={editing.apiKeyEnv ?? ''} placeholder="OPENROUTER_API_KEY" onChange={event => setEditing({ ...editing, apiKeyEnv: event.target.value || undefined })} /></label><p className="muted">Leave the endpoint blank to use OpenCode's configured providers.</p></>}
          <label>Environment references<textarea rows={3} value={env} placeholder="API_KEY=MY_PROVIDER_KEY" onChange={event => setEnv(event.target.value)} /><small className="muted">Names of variables available to Shikidan. Never enter credential values here.</small></label>
          <label>Authentication method (optional)<input value={editing.authMethod ?? ''} onChange={event => setEditing({ ...editing, authMethod: event.target.value || undefined })} /><small className="muted">A method ID from the capability probe, or blank to use the agent's existing sign-in.</small></label>
          {editing.adapter === 'cli' && <label>Output format<select value={editing.output ?? 'text'} onChange={event => setEditing({ ...editing, output: event.target.value as AgentConnection['output'] })}><option value="text">Plain text</option><option value="claude">Claude stream JSON</option><option value="codex">Codex JSON</option></select></label>}
          <label>Interactive terminal arguments · one per line<textarea rows={2} value={terminalArgs} onChange={event => setTerminalArgs(event.target.value)} placeholder="Leave empty for the app's default interface" /><small className="muted">Lets this agent open in a Shikidan terminal. Use {'{{instructions}}'} to pass its workflow instructions.</small></label>
        </details>
        <label className="switch-label"><input type="checkbox" role="switch" checked={editing.autoApprove === true} onChange={event => setEditing({ ...editing, autoApprove: event.target.checked })} />Allow this AI to use tools without asking each time</label>
        <button className="connection-button primary" type="submit" disabled={busy}>Save connection</button>
      </form>}
      <div className="connection-foot">
        {choice.kind !== 'builtin' && <><button type="button" className="connection-button" disabled={busy || editing.adapter === 'cli' || !configured} title={editing.adapter === 'cli' ? 'CLI connections have no capability probe' : !configured ? 'Save first' : undefined} onClick={() => void check()}>Check connection</button>{configured && <ConfirmRemove label="Remove connection" busy={busy} warning="Workflows that pin this AI will show it as unavailable until you pick another." onConfirm={() => void remove()} />}</>}
        <span className="muted connection-small">Checked when a job starts</span>
      </div>
      {probe && <details open><summary>Connection details</summary><pre className="studio-output">{probe}</pre></details>}
    </div>}
  </section>
}

export function StepAttachments({ node, onChange }: { node: WorkflowNode; onChange: (patch: Partial<WorkflowNode>) => void }) {
  return <div className="step-attachments">
    <h3>Skills</h3><p>Attach instructions from a Markdown skill file. Its contents are saved with each run.</p>
    {node.skills.map((path, index) => <div className="attachment-row" key={index}><label>Skill file<input value={path} placeholder="Path to SKILL.md" onChange={event => onChange({ skills: node.skills.map((item, i) => i === index ? event.target.value : item) })} /></label><button type="button" className="round" aria-label={`Remove skill ${index + 1}`} onClick={() => onChange({ skills: node.skills.filter((_, i) => i !== index) })}><Icon id="close-icon" /></button></div>)}
    <button type="button" onClick={() => onChange({ skills: [...node.skills, ''] })}>+ Attach a skill</button>
    <h3>Tools</h3><p>The AI keeps its own tools. Attach additional tools through an ACP connection.</p>
    {node.mcpServers.map((tool, index) => <fieldset className="attachment-card" key={index}><label>Tool name<input value={tool.name} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /></label><label>Executable<input value={tool.command} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, command: event.target.value } : item) })} /></label><label>Arguments · one per line<textarea rows={2} value={tool.args.join('\n')} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, args: event.target.value === '' ? [] : event.target.value.split('\n') } : item) })} /></label><div className="tool-environment"><span>Environment variables</span>{Object.entries(tool.env).map(([name, value], at) => <div className="environment-pair" key={at}><input aria-label={`Tool variable ${at + 1}`} placeholder="TOOL_KEY" value={name} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: Object.fromEntries(Object.entries(item.env).map((pair, j) => j === at ? [event.target.value, pair[1]] : pair)) } : item) })} /><input aria-label={`Server variable ${at + 1}`} placeholder="SERVER_ENV_NAME" value={value} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: { ...item.env, [name]: event.target.value } } : item) })} /><button type="button" className="round" aria-label={`Remove variable ${at + 1}`} onClick={() => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: Object.fromEntries(Object.entries(item.env).filter((_, j) => j !== at)) } : item) })}><Icon id="close-icon" /></button></div>)}<button type="button" onClick={() => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: { ...item.env, '': '' } } : item) })}>+ Add environment variable</button></div><small>Use existing environment variable names, never secret values.</small><button type="button" onClick={() => onChange({ mcpServers: node.mcpServers.filter((_, i) => i !== index) })}>Remove tool</button></fieldset>)}
    <button type="button" onClick={() => onChange({ mcpServers: [...node.mcpServers, { name: `tool-${node.mcpServers.length + 1}`, command: '', args: [], env: {} }] })}>+ Connect a tool</button>
    <h3>Acceptance checks</h3><p>These commands must succeed before this step can pass.</p>
    {node.checks.map((check, index) => <fieldset className="attachment-card" key={index}><label>Command<input value={check.command} onChange={event => onChange({ checks: node.checks.map((item, i) => i === index ? { ...item, command: event.target.value } : item) })} /></label><label>Arguments · one per line<textarea rows={2} value={check.args.join('\n')} onChange={event => onChange({ checks: node.checks.map((item, i) => i === index ? { ...item, args: event.target.value === '' ? [] : event.target.value.split('\n') } : item) })} /></label><label>Time limit (seconds)<input type="number" min={1} max={3600} value={check.timeoutSeconds} onChange={event => onChange({ checks: node.checks.map((item, i) => i === index ? { ...item, timeoutSeconds: Number(event.target.value) } : item) })} /></label><button type="button" onClick={() => onChange({ checks: node.checks.filter((_, i) => i !== index) })}>Remove check</button></fieldset>)}
    <button type="button" onClick={() => onChange({ checks: [...node.checks, { command: '', args: [], timeoutSeconds: 300 }] })}>+ Add a check</button>
  </div>
}
