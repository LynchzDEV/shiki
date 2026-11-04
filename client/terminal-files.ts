import { shellQuote, uploadDrop } from './shared'

export type FileTarget = { send(text: string): void; toast(text: string): void; upload?: (file: File) => Promise<string> }

export async function typeFiles(files: File[], localPaths: string[], target: FileTarget): Promise<number> {
  if (files.length === 0 && localPaths.length === 0) { target.toast('Nothing to add'); return 0 }
  const upload = target.upload ?? uploadDrop
  const settled = localPaths.length > 0 ? [] : await Promise.allSettled(files.map(upload))
  settled.forEach((result, index) => { if (result.status === 'rejected') target.toast(`Upload failed: ${files[index].name}`) })
  const paths = localPaths.length > 0 ? localPaths : settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  if (paths.length > 0) target.send(`${paths.map(shellQuote).join(' ')} `)
  return paths.length
}
