import type { QueueItem, QueueState } from './queue-store'
import type { RunStatus } from './workflow-runner'
import { sourceStatusSchema } from './workflows'

export type SourceStatusMap = { states?: Partial<Record<QueueState, string>>; nodes?: Record<string, string> }
export type StatusRun = { id: string; status: RunStatus; currentNodeId: string; workflow: { id: string; plugin?: string } }
export type StatusFlow = { plugin?: string; sourceStatus?: SourceStatusMap }
export type StatusMapDeps = {
  flow(id: string): Promise<StatusFlow>
  setting(plugin: string, key: string): Promise<string | null>
}

export function desiredStatus(item: QueueItem, run: StatusRun | undefined, map: SourceStatusMap): string | null {
  if (item.state !== 'building') return map.states?.[item.state] ?? null
  if (run === undefined || run.id !== item.currentRunId || run.workflow.plugin === undefined || run.status === 'blocked') return null
  return map.nodes?.[run.currentNodeId] ?? null
}

export function statusMaps(deps: StatusMapDeps): (flowId: string | null) => Promise<SourceStatusMap> {
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    console.error(message)
  }

  async function settingMap(plugin: string): Promise<SourceStatusMap | null> {
    let raw: string | null = null
    try {
      raw = await deps.setting(plugin, 'statusMap')
      return raw === null || raw.trim() === '' ? null : sourceStatusSchema.parse(JSON.parse(raw))
    } catch (error) {
      warnOnce(`${plugin}\0${raw}`, `${plugin} statusMap setting is not usable, using the flow's map: ${(error as Error).message}`)
      return null
    }
  }

  return async flowId => {
    if (flowId === null) return {}
    let flow: StatusFlow
    try {
      flow = await deps.flow(flowId)
    } catch (error) {
      const message = (error as Error).message
      if (message !== 'Workflow not found') warnOnce(`${flowId}\0${message}`, `Status map for flow ${flowId} unavailable: ${message}`)
      return {}
    }
    const fromSetting = flow.plugin === undefined ? null : await settingMap(flow.plugin)
    return fromSetting ?? flow.sourceStatus ?? {}
  }
}
