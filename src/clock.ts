// How the page shows time (2.5): the run's time in hours, the local solar time of day it has reached, minute marks.
const pad = (n: number) => String(n).padStart(2, '0')

/** Time since the start of the run, h:mm:ss (T+0:07:05, T+1:20:00). */
export function elapsed(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

/** The local solar time of day, hh:mm: the starting hour (SimConfig.hour, may be fractional) plus the run's time; past midnight it wraps. */
export function timeOfDay(hour: number, seconds: number) {
  const m = Math.floor(((hour * 60 + seconds / 60) % 1440 + 1440) % 1440)
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

/** A minute mark on a time axis: 40′ within the first hour, 1:10 from an hour on. */
export const minuteMark = (minutes: number) => minutes < 60 ? `${minutes}′` : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`

/** The same in hours and minutes, h:mm (T+0:07, T+1:20): the phone's tile has no room for seconds. */
export function elapsedShort(seconds: number) {
  const m = Math.max(0, Math.floor(seconds / 60))
  return `${Math.floor(m / 60)}:${pad(m % 60)}`
}
