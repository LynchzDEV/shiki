import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { QueueRefusal } from './queue-refusal'
import { configDir } from './secrets'

type MessageDefault = { text: string; slots: readonly string[] }

export const MESSAGES = {
  ack: { text: '✅ รับทราบครับ', slots: [] },
  clarify: {
    text: [
      'ขอโทษครับ ยังไม่แน่ใจว่าเลือกแบบไหน รบกวนตอบใหม่อีกครั้งครับ',
      '- ตอบเป็นตัวอักษร: {options}',
      '- หรือ "ไม่เอาสักแบบ" ตามด้วยสิ่งที่อยากได้',
      '- หรือ "เหมือน NOW" ถ้าไม่ต้องปรับ UI แก้บั๊กอย่างเดียว',
    ].join('\n'),
    slots: ['options'],
  },
  'confirm-none': { text: 'ได้ครับ จะทำแบบใหม่ตามนี้ครับ', slots: [] },
  'confirm-keep': { text: 'รับทราบครับ ใช้แบบเดิม (NOW) ไม่ปรับ UI แก้บั๊กอย่างเดียว', slots: [] },
  'confirm-pick': { text: 'ได้ครับ ใช้แบบ {option}', slots: ['option'] },
  'ask-header': { text: 'รบกวนช่วยเลือกหน่อยครับว่าจะให้เป็นแบบไหนครับ https://{host}', slots: ['host'] },
  recommended: { text: ' (แนะนำ)', slots: [] },
} as const satisfies Record<string, MessageDefault>

export type MessageName = keyof typeof MESSAGES
export const MESSAGE_NAMES = Object.keys(MESSAGES) as MessageName[]
export const MAX_MESSAGE = 2000
export type MessageInfo = { name: MessageName; default: string; override: string | null; slots: readonly string[] }

const SLOT = /\{([a-z]+)\}/g
const messagesDir = (): string => join(configDir(), 'messages')
const fileOf = (name: MessageName): string => join(messagesDir(), `${name}.md`)

export const isMessageName = (name: string): name is MessageName => Object.hasOwn(MESSAGES, name)
const unusable = (text: string): boolean => text.trim() === '' || text.length > MAX_MESSAGE

function override(name: MessageName): string | null {
  let text: string
  try {
    text = readFileSync(fileOf(name), 'utf8').replace(/\n+$/, '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`message ${fileOf(name)} not read, using the default`, error)
    return null
  }
  if (!unusable(text)) return text
  console.error(`message ${fileOf(name)} is empty or over ${MAX_MESSAGE} characters, using the default`)
  return null
}

export function message(name: MessageName, slots: Partial<Record<string, string>> = {}): string {
  const allowed: readonly string[] = MESSAGES[name].slots
  return (override(name) ?? MESSAGES[name].text).replace(SLOT, (token, slot: string) => {
    const value = allowed.includes(slot) ? slots[slot] : undefined
    return value === undefined ? token : value
  })
}

export const messageLines = (name: MessageName, slots: Partial<Record<string, string>> = {}): string[] => message(name, slots).split('\n')

export function listMessages(): MessageInfo[] {
  return MESSAGE_NAMES.map(name => ({ name, default: MESSAGES[name].text, override: override(name), slots: MESSAGES[name].slots }))
}

export async function setMessage(name: MessageName, text: string): Promise<void> {
  const body = text.replace(/\n+$/, '')
  if (unusable(body)) throw new QueueRefusal(`A message is 1 to ${MAX_MESSAGE} characters`, 400)
  await mkdir(messagesDir(), { recursive: true, mode: 0o700 })
  await writeFile(fileOf(name), `${body}\n`, { mode: 0o600 })
}

export async function resetMessage(name: MessageName): Promise<void> {
  await rm(fileOf(name), { force: true })
}
