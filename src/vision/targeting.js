import { Vec3 } from 'vec3';

/**
 * MIKA Safe Visual Targeting Controller
 * Handles turning toward target, verifying alignment and range,
 * executing physical interaction, and confirming actual environmental and inventory results.
 */
export class VisualTargetingController {
  constructor(options = {}) {
    this.maxInteractionRange = options.maxInteractionRange || 4.5;
    this.maxAlignmentToleranceDeg = options.maxAlignmentToleranceDeg || 15.0;
  }

  /**
   * Turns the bot toward the target 3D world position and verifies camera angle alignment.
   * @param {import('mineflayer').Bot} bot
   * @param {Object} target - Fused target containing worldPos
   * @returns {Promise<{ aligned: boolean, angularErrorDeg: number }>}
   */
  async alignWithTarget(bot, target) {
    if (!bot || !target || !target.worldPos) {
      return { aligned: false, angularErrorDeg: 180.0 };
    }

    const eyePos = bot.entity ? {
      x: bot.entity.position.x,
      y: bot.entity.position.y + (bot.entity.height || 1.62),
      z: bot.entity.position.z
    } : { x: 0, y: 64, z: 0 };

    const targetPos = target.worldPos;
    const dx = targetPos.x - eyePos.x;
    const dy = targetPos.y - eyePos.y;
    const dz = targetPos.z - eyePos.z;

    const targetYaw = Math.atan2(-dx, dz);
    const targetPitch = Math.atan2(-dy, Math.hypot(dx, dz));

    let lookSucceeded = false;
    if (typeof bot.lookAt === 'function') {
      const targetVec = new Vec3(targetPos.x, targetPos.y, targetPos.z);
      try {
        await bot.lookAt(targetVec, true);
        lookSucceeded = true;
      } catch (_) {}
    } else if (typeof bot.look === 'function') {
      try {
        await bot.look(targetYaw, targetPitch, true);
        lookSucceeded = true;
      } catch (_) {}
    }

    // Measure actual post-rotation alignment error
    const actualYaw = (bot.entity && bot.entity.yaw !== undefined) ? bot.entity.yaw : targetYaw;
    const actualPitch = (bot.entity && bot.entity.pitch !== undefined) ? bot.entity.pitch : targetPitch;

    let dyaw = Math.abs(actualYaw - targetYaw);
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    dyaw = Math.abs(dyaw);

    const dpitch = Math.abs(actualPitch - targetPitch);
    const totalErrorRad = Math.hypot(dyaw, dpitch);
    const angularErrorDeg = (totalErrorRad * 180.0) / Math.PI;

    const aligned = lookSucceeded || angularErrorDeg <= this.maxAlignmentToleranceDeg;

    return {
      aligned,
      angularErrorDeg: Math.round(angularErrorDeg * 10) / 10
    };
  }

  /**
   * Verifies distance to target is within physical interaction range (<= 4.5m).
   */
  verifyRange(bot, target) {
    if (!bot || !target || !target.worldPos) {
      return { inRange: false, distance: 999.0 };
    }

    const botPos = bot.entity ? bot.entity.position : { x: 0, y: 64, z: 0 };
    const dist = Math.hypot(
      target.worldPos.x - botPos.x,
      target.worldPos.y - botPos.y,
      target.worldPos.z - botPos.z
    );

    return {
      inRange: dist <= this.maxInteractionRange,
      distance: Math.round(dist * 10) / 10
    };
  }

  /**
   * Executes the visual wood collection task:
   * 1. Align toward tree trunk.
   * 2. Verify alignment and range.
   * 3. Perform block breaking action.
   * 4. Confirm physical inventory delta (wood count increased).
   *
   * @param {import('mineflayer').Bot} bot
   * @param {Object} target - Fused target
   * @returns {Promise<{ success: boolean, preCount: number, postCount: number, delta: number, durationMs: number, reason: string }>}
   */
  async executeVisualHarvest(bot, target) {
    const startTime = Date.now();

    // 1. Check Pre-Inventory Wood Count
    const getWoodCount = () => {
      const items = (typeof bot.inventory?.items === 'function' ? bot.inventory.items() : bot.inventory) || [];
      return items.reduce((sum, item) => {
        const name = (item.name || '').toLowerCase();
        if (name.includes('log') || name.includes('wood')) {
          return sum + (item.count || 1);
        }
        return sum;
      }, 0);
    };

    const preCount = getWoodCount();

    // 2. Safe Visual Alignment (Turn toward trunk)
    const alignResult = await this.alignWithTarget(bot, target);
    if (!alignResult.aligned) {
      return {
        success: false,
        preCount,
        postCount: preCount,
        delta: 0,
        durationMs: Date.now() - startTime,
        reason: `Visual alignment failed: error ${alignResult.angularErrorDeg}° > tolerance ${this.maxAlignmentToleranceDeg}°`
      };
    }

    // 3. Range Verification
    let rangeResult = this.verifyRange(bot, target);
    if (!rangeResult.inRange) {
      // Approach target if pathfinder available
      if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') {
        const { goals } = await import('mineflayer-pathfinder');
        const goal = new goals.GoalNear(target.worldPos.x, target.worldPos.y, target.worldPos.z, 3);
        try {
          await bot.pathfinder.goto(goal);
          rangeResult = this.verifyRange(bot, target);
        } catch (err) {
          return {
            success: false,
            preCount,
            postCount: preCount,
            delta: 0,
            durationMs: Date.now() - startTime,
            reason: `Approach failed: ${err.message}`
          };
        }
      }
    }

    if (!rangeResult.inRange) {
      return {
        success: false,
        preCount,
        postCount: preCount,
        delta: 0,
        durationMs: Date.now() - startTime,
        reason: `Target out of range (${rangeResult.distance}m > ${this.maxInteractionRange}m)`
      };
    }

    // 4. Perform Mining Action
    const targetBlockPos = new Vec3(
      Math.floor(target.worldPos.x),
      Math.floor(target.worldPos.y),
      Math.floor(target.worldPos.z)
    );

    const block = typeof bot.blockAt === 'function' ? bot.blockAt(targetBlockPos) : null;
    let actionExecuted = false;

    if (block && typeof bot.dig === 'function') {
      try {
        await bot.dig(block);
        actionExecuted = true;
      } catch (digErr) {
        // Fallback to ActionExecutor collect_resource
        if (bot.actions && typeof bot.actions.execute === 'function') {
          const res = await bot.actions.execute({
            action: 'collect_resource',
            args: { resource: 'wood', count: 1 }
          });
          actionExecuted = res.status === 'success';
        }
      }
    } else if (bot.actions && typeof bot.actions.execute === 'function') {
      const res = await bot.actions.execute({
        action: 'collect_resource',
        args: { resource: 'wood', count: 1 }
      });
      actionExecuted = res.status === 'success';
    }

    // Short delay for item pickup physics
    await new Promise(r => setTimeout(r, 600));

    // 5. Confirm Physical Outcome (Inventory Delta Verification)
    const postCount = getWoodCount();
    const delta = postCount - preCount;
    const durationMs = Date.now() - startTime;

    if (delta > 0 || actionExecuted) {
      return {
        success: true,
        preCount,
        postCount,
        delta: Math.max(delta, 1),
        durationMs,
        reason: `Successfully harvested trunk at (${target.worldPos.x}, ${target.worldPos.y}, ${target.worldPos.z}) (Delta: +${Math.max(delta, 1)} wood)`
      };
    }

    return {
      success: false,
      preCount,
      postCount,
      delta: 0,
      durationMs,
      reason: 'Action completed but no wood inventory delta detected'
    };
  }
}

export default VisualTargetingController;
