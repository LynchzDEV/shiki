import { isTouchLayout } from './shared'

const GAP = 22
const REACH = 150
const FOLLOW = 0.12
const FADE = 0.08
const DOT_ALPHA = 0.6
const RIPPLE_SPEED = 0.45
const RIPPLE_BAND = 36
const RIPPLE_LIFE = 1100
const PAUSED_KEY = 'skd.motion.paused'
const INTERACTIVE = 'button, a, input, textarea, select, pre, .session-card, dialog, nav, header, .term-host, .composer, .skd-panes, .md'
const isDark = (): boolean => document.documentElement.dataset.theme === 'dark'
const dotColor = (mix: number): string => isDark() ? `rgb(${59 + mix * 106}, ${64 + mix * 75}, ${76 + mix * 150})` : `rgb(${250 - mix * 122}, ${251 - mix * 153}, ${255 - mix * 66})`

type Dot = { x: number; y: number; phase: number; speed: number; near: number }
type Ripple = { x: number; y: number; start: number }

function readPaused(): boolean {
  try { const stored = localStorage.getItem(PAUSED_KEY); if (stored !== null) return stored === 'true' } catch {}
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

const canvas = document.getElementById('backdrop') as HTMLCanvasElement | null
const motion = document.getElementById('motion') as HTMLInputElement | null
const context = canvas?.getContext('2d')
if (canvas && motion && context && !isTouchLayout()) {
  let paused = readPaused()
  let dots: Dot[] = []
  const ripples: Ripple[] = []
  const mouse = { x: -1e4, y: -1e4 }
  const lens = { x: -1e4, y: -1e4 }
  motion.checked = !paused
  const wake = (): void => { settledFrames = 0; if (!drawing) requestAnimationFrame(draw) }
  motion.onchange = () => { paused = !motion.checked; try { localStorage.setItem(PAUSED_KEY, String(paused)) } catch {} wake() }
  document.addEventListener('mc:theme', wake)
  const size = (): void => {
    canvas.width = innerWidth
    canvas.height = innerHeight
    dots = []
    for (let y = GAP; y < innerHeight; y += GAP) for (let x = GAP; x < innerWidth; x += GAP) dots.push({ x, y, phase: Math.random() * Math.PI * 2, speed: 0.3 + Math.random() * 0.7, near: 0 })
  }
  window.addEventListener('pointermove', event => { mouse.x = event.clientX; mouse.y = event.clientY })
  document.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4 })
  window.addEventListener('click', event => {
    if (paused || (event.target as Element | null)?.closest(INTERACTIVE)) return
    ripples.push({ x: event.clientX, y: event.clientY, start: performance.now() })
  })
  let drawing = false
  let settledFrames = 0
  const draw = (time: number): void => {
    drawing = true
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (mouse.x < -1e3 || lens.x < -1e3) { lens.x = mouse.x; lens.y = mouse.y } else { lens.x += (mouse.x - lens.x) * FOLLOW; lens.y += (mouse.y - lens.y) * FOLLOW }
    while (ripples.length && time - ripples[0].start > RIPPLE_LIFE) ripples.shift()
    context.globalAlpha = DOT_ALPHA
    for (const dot of dots) {
      let wave = 0
      for (const ripple of ripples) {
        const age = time - ripple.start
        const off = Math.abs(Math.hypot(dot.x - ripple.x, dot.y - ripple.y) - age * RIPPLE_SPEED)
        if (off < RIPPLE_BAND) wave = Math.max(wave, (1 - off / RIPPLE_BAND) * (1 - age / RIPPLE_LIFE))
      }
      const twinkle = paused ? 0.2 : Math.max(0, Math.sin(time / 1000 * dot.speed + dot.phase)) ** 6
      const target = paused ? 0 : Math.max(0, 1 - Math.hypot(dot.x - lens.x, dot.y - lens.y) / REACH) ** 2
      dot.near += (target - dot.near) * FADE
      const push = dot.near * 4 + wave * 5
      const angle = Math.atan2(dot.y - lens.y, dot.x - lens.x)
      const mix = Math.min(1, twinkle * 0.35 + dot.near * 0.35 + wave * 0.8)
      context.fillStyle = dotColor(mix)
      context.beginPath()
      context.arc(dot.x + Math.cos(angle) * push, dot.y + Math.sin(angle) * push, 1.4 + twinkle * 0.8 + dot.near * 0.9 + wave * 1.6, 0, Math.PI * 2)
      context.fill()
    }
    settledFrames = paused && ripples.length === 0 ? settledFrames + 1 : 0
    if (settledFrames > 90) { drawing = false; return }
    requestAnimationFrame(draw)
  }
  size()
  addEventListener('resize', () => { size(); wake() })
  requestAnimationFrame(draw)
}
