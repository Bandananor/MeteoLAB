// The settings a scenario does not set itself: the simulator starts from these, then applies the scenario's values.
import type { SimConfig } from './core'

export const DEFAULTS: SimConfig = {
  surfaceTemp:30,lapseLow:8.4,lapseMid:7.2,lapseUpper:6.5,tropopause:11,stratoWarming:1.2,capHeight:1.5,capStrength:0,moistLayer:0,
  rhSurface:72,rhLow:60,rhMid:42,rhUpper:28,
  wind0:2,wind3:10,wind6:20,wind10:28,windDir0:160,windDir3:185,windDir6:215,windDir10:235,
  latitude:45,turbulence:.55,
  hour:13.5,dayOfYear:80,solarMax:1000,soilMoisture:45,surfaceType:'grass',city:0,
  speed:8,seed:42,bubble:1
}

// Scenarios without the 0.5 and 1 km wind nodes get them on the straight 0-3 km line, so their hodograph is unchanged
// and the sliders show where the nodes are.
export const fillLowWind = (c: SimConfig) => {
  const along = (a: number, b: number, t: number) => a + (b - a) * t, turn = (a: number, b: number, t: number) => ((a + (((b - a + 540) % 360) - 180) * t) % 360 + 360) % 360
  c.wind05 ??= along(c.wind0, c.wind3, 1 / 6); c.wind1 ??= along(c.wind0, c.wind3, 1 / 3)
  c.windDir05 ??= turn(c.windDir0, c.windDir3, 1 / 6); c.windDir1 ??= turn(c.windDir0, c.windDir3, 1 / 3)
}
