// The observer on the ground (the view from the ground, view.ts): where they stand and how they move. Fixed to the
// ground, not to the domain: as the domain follows a storm, the storm passes them by. They stand still for now; the
// motion is the groundwork for a storm chaser — driving after a storm along the ground (later: roads, a car's speed
// and the time it takes, reports from the field).

/** A ground point, m from the ground origin (x east, y north; see core domainPoint and groundPoint). */
export interface GroundPoint { x: number; y: number }

/** How the observer moves: on foot, or by car on a country road (m/s). */
export const WALK_SPEED = 1.4, CAR_SPEED = 25

export class Observer {
  /** Where they stand, m from the ground origin. */
  x: number; y: number
  /** Their eyes over the ground, m. */
  eyeHeight = 2
  /** Where they are heading and how fast (m/s); null standing. */
  private goal: GroundPoint | null = null; private speed = 0

  constructor(at: GroundPoint) { this.x = at.x; this.y = at.y }

  /** Stands at a point at once. */
  standAt(at: GroundPoint) { this.x = at.x; this.y = at.y; this.goal = null }

  /** Heads for a point at a speed (m/s), straight over the ground; step() moves them. */
  moveTo(at: GroundPoint, speed = CAR_SPEED) { this.goal = { ...at }; this.speed = speed }

  /** Stops where they are. */
  stop() { this.goal = null }

  /** Whether they are on the way somewhere. */
  get moving() { return this.goal !== null }

  /** Their velocity over the ground now, m/s (east, north). */
  get velocity(): [number, number] {
    if (!this.goal) return [0, 0]
    const dx = this.goal.x - this.x, dy = this.goal.y - this.y, d = Math.hypot(dx, dy)
    return d > 0 ? [dx / d * this.speed, dy / d * this.speed] : [0, 0]
  }

  /** Moves them by `dt` s of the model's time (the storm's time: a car keeps pace with the run, not with the screen). */
  step(dt: number) {
    if (!this.goal || dt <= 0) return
    const dx = this.goal.x - this.x, dy = this.goal.y - this.y, d = Math.hypot(dx, dy), go = this.speed * dt
    if (go >= d) { this.x = this.goal.x; this.y = this.goal.y; this.goal = null; return }
    this.x += dx / d * go; this.y += dy / d * go
  }
}
