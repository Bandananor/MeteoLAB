/**
 * Captions burnt into a video's frames (roadmap M4, for short videos): what is shown, when, and what the storm is doing,
 * from the model's own numbers. A vertical frame keeps them out of where a phone app lays its buttons and its text
 * (roughly the bottom fifth and a right strip), so the event's line stands above that.
 */

export interface Caption {
  /** The scenario or the run's name. */
  title: string
  /** The model time and the local time. */
  time: string
  /** What the storm is: «Суперячейка с мезоциклоном». */
  event: string
  /** Its numbers: «поток 38 м/с · дождь 62 мм/ч». */
  numbers: string
}

/** Where the captions go in a `width` x `height` frame: the text's size, the side margin, the top block's and the event's baselines. */
export function captionLayout(width: number, height: number) {
  const vertical = height > width, unit = Math.min(width, height)
  const size = Math.round(unit * (vertical ? .052 : .042)), margin = Math.round(unit * .06)
  return {
    size, margin,
    /** Top: the title's baseline, the time's under it. */
    top: margin + size,
    /** The event's baseline, its numbers' under it: above the bottom fifth in a vertical frame, near the bottom otherwise. */
    event: Math.round(vertical ? height * .72 : height - margin - size * 1.4),
    /** The text's widest: short of a phone app's right strip in a vertical frame. */
    maxWidth: Math.round(width - margin - (vertical ? width * .18 : margin)),
  }
}

/** The parts of a line (joined by « · ») in as few lines as fit, a part never split (a narrow vertical frame takes two). */
export function wrapParts(parts: readonly string[], fits: (line: string) => boolean) {
  const lines: string[] = []
  for (const p of parts) {
    const last = lines.length ? lines[lines.length - 1] : null
    if (last !== null && fits(`${last} · ${p}`)) lines[lines.length - 1] = `${last} · ${p}`; else lines.push(p)
  }
  return lines
}

const FONT = "Onest, 'Segoe UI', system-ui, sans-serif"

/** Draws the captions over the frame in `ctx`: white text with a soft shadow on a light darkening of the top and the event's band. */
export function drawCaptions(ctx: CanvasRenderingContext2D, width: number, height: number, c: Caption) {
  const { size, margin, top, event, maxWidth } = captionLayout(width, height)
  ctx.save()
  // The bands darken the sky under the text a little, so it reads on a bright cloud.
  const band = (y0: number, y1: number, up: boolean) => {
    const g = ctx.createLinearGradient(0, up ? y1 : y0, 0, up ? y0 : y1)
    g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g; ctx.fillRect(0, y0, width, y1 - y0)
  }
  band(0, top + size * 2.2, true)
  if (c.event || c.numbers) band(event - size * 2, event + size * 3.2, false)
  ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = size * .25; ctx.textBaseline = 'alphabetic'
  const text = (s: string, y: number, weight: number, scale: number, alpha = 1) => {
    if (!s) return
    ctx.globalAlpha = alpha; ctx.font = `${weight} ${Math.round(size * scale)}px ${FONT}`
    ctx.fillText(s, margin, y, maxWidth)
  }
  text(c.title, top, 650, 1)
  text(c.time, top + size * 1.3, 450, .78, .9)
  text(c.event, event, 650, .95)
  // The numbers wrap rather than squeeze.
  ctx.font = `450 ${Math.round(size * .78)}px ${FONT}`
  wrapParts(c.numbers ? c.numbers.split(' · ') : [], l => ctx.measureText(l).width <= maxWidth).forEach((l, k) => text(l, event + size * (1.25 + k), 450, .78, .9))
  // The source, small, in the corner the apps leave alone (top right).
  ctx.globalAlpha = .75; ctx.font = `500 ${Math.round(size * .55)}px ${FONT}`; ctx.textAlign = 'right'
  ctx.fillText('MeteoLab', width - margin, margin + size * .55)
  ctx.restore()
}
