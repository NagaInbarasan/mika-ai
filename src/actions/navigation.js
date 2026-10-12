import pathfinderPkg from 'mineflayer-pathfinder';
const { goals, Movements } = pathfinderPkg.default || pathfinderPkg;

/**
 * Navigates the bot to target coordinates or target entity.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} args
 * @param {number} args.x - Target X coordinate
 * @param {number} [args.y] - Target Y coordinate
 * @param {number} args.z - Target Z coordinate
 * @param {number} [args.range=1.5] - Distance tolerance to target
 * @param {number} [args.timeout_ms=20000] - Max duration
 * @returns {Promise<Object>} Execution result
 */
export async function executeNavigateTo(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  if (args.x === undefined || args.z === undefined) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENTS', error: 'Missing x or z coordinate for navigate_to' };
  }

  const targetX = Number(args.x);
  const targetZ = Number(args.z);
  const targetY = args.y !== undefined ? Number(args.y) : Math.floor(bot.entity.position.y);
  const range = args.range !== undefined ? Number(args.range) : 1.5;
  const timeoutMs = args.timeout_ms || 20000;

  if (isNaN(targetX) || isNaN(targetZ) || isNaN(targetY)) {
    return { status: 'failed', error_code: 'INVALID_COORDINATES', error: 'Coordinates must be valid numbers' };
  }

  // Precondition: if already within range
  const currentDist = typeof bot.entity.position.distanceTo === 'function'
    ? bot.entity.position.distanceTo({ x: targetX, y: targetY, z: targetZ })
    : Math.hypot(targetX - bot.entity.position.x, targetZ - bot.entity.position.z);
  if (currentDist <= range) {
    return {
      status: 'success',
      data: {
        reached: true,
        final_distance: Math.round(currentDist * 10) / 10,
        message: 'Already within range of target'
      }
    };
  }

  if (!bot.pathfinder) {
    return { status: 'failed', error_code: 'PATHFINDER_UNAVAILABLE', error: 'Pathfinder plugin is not loaded' };
  }

  // Set movements
  try {
    const defaultMove = new Movements(bot);
    if (typeof bot.pathfinder.setMovements === 'function') {
      bot.pathfinder.setMovements(defaultMove);
    }
  } catch (_) {}

  let goal;
  try {
    goal = new goals.GoalNear(targetX, targetY, targetZ, range);
  } catch (_) {
    goal = { x: targetX, y: targetY, z: targetZ, range };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let timeoutTimer = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      bot.off('goal_reached', onGoalReached);
      bot.off('path_reset', onPathReset);
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        bot.pathfinder.stop();
      } catch (_) {}
      resolve(result);
    };

    const onGoalReached = () => {
      const finalDist = typeof bot.entity.position.distanceTo === 'function'
        ? bot.entity.position.distanceTo({ x: targetX, y: targetY, z: targetZ })
        : Math.hypot(targetX - bot.entity.position.x, targetZ - bot.entity.position.z);
      finish({
        status: 'success',
        data: {
          reached: true,
          final_distance: Math.round(finalDist * 10) / 10
        }
      });
    };

    const onPathReset = (reason) => {
      if (reason === 'noPath') {
        finish({
          status: 'failed',
          error_code: 'UNREACHABLE_TARGET',
          error: `No valid path found to target (${targetX}, ${targetY}, ${targetZ})`
        });
      }
    };

    timeoutTimer = setTimeout(() => {
      const dist = typeof bot.entity.position.distanceTo === 'function'
        ? bot.entity.position.distanceTo({ x: targetX, y: targetY, z: targetZ })
        : Math.hypot(targetX - bot.entity.position.x, targetZ - bot.entity.position.z);
      finish({
        status: 'timeout',
        error_code: 'NAVIGATION_TIMEOUT',
        error: `Navigation timed out after ${timeoutMs}ms. Remaining distance: ${dist.toFixed(1)}m`
      });
    }, timeoutMs);

    bot.once('goal_reached', onGoalReached);
    bot.on('path_reset', onPathReset);

    try {
      bot.pathfinder.setGoal(goal);
    } catch (err) {
      finish({
        status: 'failed',
        error_code: 'PATHFINDER_START_ERROR',
        error: err.message
      });
    }
  });
}
