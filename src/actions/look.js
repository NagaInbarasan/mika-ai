/**
 * Rotates the bot's gaze safely.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} args
 * @param {number} [args.yaw] - Target yaw in radians
 * @param {number} [args.pitch] - Target pitch in radians
 * @param {number} [args.timeout_ms=3000]
 * @returns {Promise<Object>} Execution details
 */
export async function executeLookAround(bot, args = {}) {
  const targetYaw = args.yaw !== undefined ? args.yaw : bot.entity.yaw + (Math.PI / 2);
  const targetPitch = args.pitch !== undefined ? args.pitch : 0;

  try {
    await bot.look(targetYaw, targetPitch, true);
    return {
      status: 'success',
      data: {
        final_yaw: Math.round(bot.entity.yaw * 100) / 100,
        final_pitch: Math.round(bot.entity.pitch * 100) / 100
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'LOOK_FAILED',
      error: err.message
    };
  }
}
