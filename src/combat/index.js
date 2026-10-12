import { defaultEquipment } from './equipment.js';
import { defaultCombatTactics } from './tactics.js';
import { defaultThreatAnalyzer } from './threats.js';
import { defaultProgression } from '../progression/state-machine.js';

/**
 * Combat actions dispatcher and executor.
 */

export async function executeAttackTarget(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const targetName = args.mob || args.target;
  let targetEntity = null;

  if (targetName) {
    // Search by name
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e && e.name === targetName && e !== bot.entity) {
        targetEntity = e;
        break;
      }
    }
  } else {
    // Select highest priority threat nearby
    const threats = defaultThreatAnalyzer.evaluateThreats(bot, 12);
    if (threats.length > 0) {
      targetEntity = threats[0].entity;
    }
  }

  if (!targetEntity) {
    return {
      status: 'failed',
      error_code: 'TARGET_NOT_FOUND',
      error: `No hostile target '${targetName || 'any'}' found in range`
    };
  }

  // If target is beyond melee reach, navigate into range
  if (bot.pathfinder && bot.entity.position && targetEntity.position) {
    const dist = typeof bot.entity.position.distanceTo === 'function'
      ? bot.entity.position.distanceTo(targetEntity.position)
      : Math.hypot(bot.entity.position.x - targetEntity.position.x, bot.entity.position.z - targetEntity.position.z);
    if (dist > 3.0) {
      try {
        const pathfinderPkg = await import('mineflayer-pathfinder');
        const { goals } = pathfinderPkg.default || pathfinderPkg;
        if (goals && goals.GoalFollow && typeof bot.pathfinder.setGoal === 'function') {
          bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 2.5), true);
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 3500);
            const checkInterval = setInterval(() => {
              if (!bot.entity || !targetEntity.position) {
                clearInterval(checkInterval);
                clearTimeout(timeout);
                resolve();
                return;
              }
              const d = typeof bot.entity.position.distanceTo === 'function'
                ? bot.entity.position.distanceTo(targetEntity.position)
                : 0;
              if (d <= 2.8) {
                clearInterval(checkInterval);
                clearTimeout(timeout);
                if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
                resolve();
              }
            }, 250);
          });
        }
      } catch (_) {}
    }
  }

  // Ensure best weapon is equipped
  await defaultEquipment.autoEquip(bot);

  const attackResult = await defaultCombatTactics.executeAttack(bot, targetEntity, {
    criticalHit: args.critical !== false
  });

  if (attackResult.status === 'success') {
    // If mob died or was damaged, track in progression
    defaultProgression.recordKill(targetEntity.name, 7);
  }

  return attackResult;
}

export async function executeDefendWithShield(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const durationMs = args.duration_ms || 2500;
  const threats = defaultThreatAnalyzer.evaluateThreats(bot, 10);
  const primaryThreat = threats[0] || null;

  await defaultCombatTactics.raiseShield(bot, primaryThreat);
  await new Promise(r => setTimeout(r, durationMs));
  defaultCombatTactics.lowerShield(bot);

  return {
    status: 'success',
    duration_ms: durationMs,
    data: { defended_against: primaryThreat ? primaryThreat.name : 'ambient' }
  };
}

export async function executeRetreatAndHeal(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const threats = defaultThreatAnalyzer.evaluateThreats(bot, 10);
  const primaryThreat = threats[0] || null;

  return await defaultCombatTactics.executeRetreat(bot, primaryThreat);
}

export async function executeEquipGear(bot, args = {}) {
  return await defaultEquipment.autoEquip(bot);
}

export default {
  executeAttackTarget,
  executeDefendWithShield,
  executeRetreatAndHeal,
  executeEquipGear
};
