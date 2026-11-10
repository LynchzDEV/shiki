import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { QueueRefusal } from '../queue-refusal'
import { configDir } from '../secrets'
import { identifier } from '../workflows'

export const FLOW_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/
const REFUSED = 'Only instructions and title can be overridden: checks, setup, edges, agents and land stages run commands or change routing'

export const overlayNodeSchema = z.object({
  instructions: z.string().trim().min(1).max(32000).optional(),
  title: z.string().trim().min(1).max(120).optional(),
}).strict()
const overlaySchema = z.object({ nodes: z.record(identifier, overlayNodeSchema) }).strict()

export type FlowOverlay = z.infer<typeof overlaySchema>
export type OverlayNode = z.infer<typeof overlayNodeSchema>

const overlayFile = (flowId: string): string => {
  if (!FLOW_ID.test(flowId)) throw new QueueRefusal(`Not a flow id: ${flowId}`, 400)
  return join(configDir(), 'flow-overlays', `${flowId}.json`)
}

async function stored(flowId: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(overlayFile(flowId), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nodes: {} }
    throw error
  }
}

export async function readFlowOverlay(flowId: string): Promise<FlowOverlay | null> {
  try {
    const parsed = overlaySchema.safeParse(await stored(flowId))
    if (parsed.success) return Object.keys(parsed.data.nodes).length === 0 ? null : parsed.data
    console.error(`[plugins] flow overlay ${flowId} is not used: ${REFUSED}, each up to its normal length`)
  } catch (error) {
    console.error(`[plugins] flow overlay ${flowId} is not used:`, error instanceof Error ? error.message : String(error))
  }
  return null
}

export function overlaid<T extends { id?: unknown }>(flowId: string, nodes: readonly T[], overlay: FlowOverlay | null): T[] {
  if (overlay === null) return [...nodes]
  const known = new Set(nodes.map(node => node.id))
  for (const id of Object.keys(overlay.nodes).filter(id => !known.has(id))) console.error(`[plugins] flow overlay ${flowId}: no step ${id}, skipped`)
  return nodes.map(node => (typeof node.id === 'string' && Object.hasOwn(overlay.nodes, node.id) ? { ...node, ...overlay.nodes[node.id] } : node))
}

export function overlayNodeOf(raw: unknown): OverlayNode {
  const parsed = overlayNodeSchema.safeParse(raw)
  if (!parsed.success) throw new QueueRefusal(REFUSED, 400)
  if (parsed.data.instructions === undefined && parsed.data.title === undefined) throw new QueueRefusal('Send instructions, title or both', 400)
  return parsed.data
}

async function save(flowId: string, overlay: FlowOverlay): Promise<void> {
  const path = overlayFile(flowId)
  if (Object.keys(overlay.nodes).length === 0) return rm(path, { force: true })
  await mkdir(join(configDir(), 'flow-overlays'), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
}

const current = async (flowId: string): Promise<FlowOverlay> => {
  overlayFile(flowId)
  return (await readFlowOverlay(flowId)) ?? { nodes: {} }
}

export async function setOverlayNode(flowId: string, nodeId: string, node: OverlayNode): Promise<FlowOverlay> {
  if (!identifier.safeParse(nodeId).success) throw new QueueRefusal(`Not a step id: ${nodeId}`, 400)
  const overlay = await current(flowId)
  const next = { nodes: { ...overlay.nodes, [nodeId]: node } }
  await save(flowId, next)
  return next
}

export async function clearOverlay(flowId: string, nodeId?: string): Promise<FlowOverlay> {
  const overlay = await current(flowId)
  const next = { nodes: nodeId === undefined ? {} : Object.fromEntries(Object.entries(overlay.nodes).filter(([id]) => id !== nodeId)) }
  await save(flowId, next)
  return next
}
