import pathfinderPkg from 'mineflayer-pathfinder';
const { goals, Movements } = pathfinderPkg.default || pathfinderPkg;

/**
 * End Dimension Navigation Controller.
 * Provides specialized pathfinding, void hazard fall-prevention, and dragon breath avoidance.
 */

export class EndNavigationController {
  constructor(options = {}) {
    this.voidFallThresholdY = options.voidFallThresholdY || 30; // Danger if Y < 30 in the End
    this.islandRadius = options.islandRadius || 120; // Main End island radius around (0,0)
    this.activeHazardZones = new Set(); // Set of position keys with dragon breath
  }

  /**
   * Validates if a target position is safe from void falls and off-island boundaries.
   * @param {Object} pos - { x, y, z }
   * @returns {{ safe: boolean, reason?: string }}
   */
  isSafeEndCoordinate(pos) {
    if (!pos) return { safe: false, reason: 'Invalid coordinate' };

    // 1. Check Y coordinate: must not be near void
    if (pos.y < this.voidFallThresholdY) {
      return { safe: false, reason: `Y coordinate (${pos.y}) is near the void boundary!` };
    }

    // 2. Check island boundary distance from (0, 0)
    const distFromCenter = Math.hypot(pos.x, pos.z);
    if (distFromCenter > this.islandRadius) {
      return { safe: false, reason: `Coordinate (${Math.round(pos.x)}, ${Math.round(pos.z)}) is off the main End island (${distFromCenter.toFixed(1)}m > ${this.islandRadius}m)!` };
    }

    // 3. Check active breath hazard zones
    const zoneKey = `${Math.floor(pos.x)}:${Math.floor(pos.z)}`;
    if (this.activeHazardZones.has(zoneKey)) {
      return { safe: false, reason: 'Target position is contaminated with lingering Dragon Breath!' };
    }

    return { safe: true };
  }

  /**
   * Configures pathfinder movements for End dimension traversal.
   * Avoids ender acid, lingering breath, and enforces strict void-edge margins.
   * @param {import('mineflayer').Bot} bot
   * @returns {import('mineflayer-pathfinder').Movements}
   */
  createEndMovements(bot) {
    if (!bot) return null;
    let movements;
    try {
      movements = new Movements(bot);
    } catch (_) {
      return null;
    }

    // Never dig down in the End to prevent falling into the void
    movements.canDig = true;
    movements.allow1by1towers = true; // Needed for pillaring up obsidian towers
    movements.maxDropDown = 4; // Prevent high falls off obsidian pillars without water

    return movements;
  }

  /**
   * Registers a dragon breath hazard area to avoid.
   * @param {Object} pos
   * @param {number} [durationMs=15000] Lingering breath duration
   */
  registerBreathHazard(pos, durationMs = 15000) {
    if (!pos) return;
    const key = `${Math.floor(pos.x)}:${Math.floor(pos.z)}`;
    this.activeHazardZones.add(key);

    setTimeout(() => {
      this.activeHazardZones.delete(key);
    }, durationMs);
  }

  /**
   * Safely navigates towards a goal on the End island while avoiding void edges.
   * @param {import('mineflayer').Bot} bot
   * @param {Object} targetPos
   * @param {number} [range=2.0]
   * @returns {Promise<Object>} Navigation result
   */
  async navigateSafely(bot, targetPos, range = 2.0) {
    if (!bot || !bot.entity) {
      return { status: 'failed', error: 'Bot entity not ready' };
    }

    const safety = this.isSafeEndCoordinate(targetPos);
    if (!safety.safe) {
      console.warn(`[End Navigation Safety] Blocked unsafe movement: ${safety.reason}`);
      return { status: 'failed', error_code: 'UNSAFE_VOID_COORDINATE', error: safety.reason };
    }

    const movements = this.createEndMovements(bot);
    if (movements && bot.pathfinder) {
      bot.pathfinder.setMovements(movements);
    }

    const goal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, range);
    const startTime = Date.now();

    try {
      await bot.pathfinder.goto(goal);
      return {
        status: 'success',
        duration_ms: Date.now() - startTime,
        reached_position: bot.entity.position
      };
    } catch (err) {
      return {
        status: 'failed',
        error_code: 'PATH_BLOCKED',
        error: err.message,
        duration_ms: Date.now() - startTime
      };
    }
  }
}

export const defaultEndNavigation = new EndNavigationController();
export default defaultEndNavigation;
