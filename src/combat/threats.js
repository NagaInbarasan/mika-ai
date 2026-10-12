/**
 * Hostile Mob Threat Evaluator & Priority Analyzer.
 */

export const MOB_THREAT_TIERS = {
  creeper: { priority: 1, danger: 'high', attackMode: 'proximity_explosion', safeRange: 6.0 },
  skeleton: { priority: 2, danger: 'high', attackMode: 'ranged_arrows', safeRange: 4.0 },
  bogged: { priority: 2, danger: 'high', attackMode: 'poison_arrows', safeRange: 4.0 },
  stray: { priority: 2, danger: 'high', attackMode: 'slowness_arrows', safeRange: 4.0 },
  blaze: { priority: 1, danger: 'high', attackMode: 'fireballs', safeRange: 8.0 },
  husk: { priority: 3, danger: 'medium', attackMode: 'melee_hunger', safeRange: 3.0 },
  zombie: { priority: 4, danger: 'medium', attackMode: 'melee', safeRange: 3.0 },
  spider: { priority: 4, danger: 'medium', attackMode: 'leap_melee', safeRange: 3.5 },
  cave_spider: { priority: 3, danger: 'high', attackMode: 'poison_melee', safeRange: 3.0 },
  enderman: { priority: 2, danger: 'extreme', attackMode: 'teleport_heavy_melee', safeRange: 5.0 },
  witch: { priority: 2, danger: 'high', attackMode: 'splash_potions', safeRange: 6.0 },
  ender_dragon: { priority: 1, danger: 'boss', attackMode: 'breath_perch_charge', safeRange: 16.0 }
};

export class ThreatAnalyzer {
  /**
   * Evaluates all nearby entities and extracts prioritized hostile threats.
   * @param {import('mineflayer').Bot} bot
   * @param {number} [maxDistance=16]
   * @returns {Array<Object>} Sorted threats (highest danger first)
   */
  evaluateThreats(bot, maxDistance = 16) {
    if (!bot || !bot.entities) return [];

    const botPos = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
    const threats = [];

    for (const id in bot.entities) {
      const entity = bot.entities[id];
      if (!entity || !entity.name || entity === bot.entity) continue;

      const mobInfo = MOB_THREAT_TIERS[entity.name];
      if (!mobInfo) continue; // Not a designated hostile mob

      const dist = entity.position.distanceTo ? entity.position.distanceTo(botPos) : Math.hypot(
        entity.position.x - botPos.x,
        entity.position.y - botPos.y,
        entity.position.z - botPos.z
      );

      if (dist <= maxDistance) {
        threats.push({
          id: entity.id,
          name: entity.name,
          distance: Math.round(dist * 10) / 10,
          position: entity.position,
          priority: mobInfo.priority,
          danger: mobInfo.danger,
          attackMode: mobInfo.attackMode,
          safeRange: mobInfo.safeRange,
          isCriticalProximity: dist <= (mobInfo.safeRange / 2),
          entity
        });
      }
    }

    // Sort by priority (1 is highest), then by distance (closest first)
    threats.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.distance - b.distance;
    });

    return threats;
  }

  /**
   * Suggests immediate combat tactic for a given threat.
   * @param {Object} threat
   * @param {number} currentHealth
   * @returns {{ tactic: string, useShield: boolean, shouldRetreat: boolean, reason: string }}
   */
  recommendTactic(threat, currentHealth = 20) {
    if (currentHealth <= 8.0) {
      return {
        tactic: 'retreat_and_heal',
        useShield: true,
        shouldRetreat: true,
        reason: `Health is critical (${currentHealth}/20). Retreat immediately to safe distance and consume food.`
      };
    }

    if (threat.name === 'creeper') {
      if (threat.distance <= 3.5) {
        return {
          tactic: 'backpedal_and_shield',
          useShield: true,
          shouldRetreat: true,
          reason: 'Creeper within explosive priming radius! Back away with shield raised.'
        };
      } else {
        return {
          tactic: 'hit_and_retreat',
          useShield: false,
          shouldRetreat: false,
          reason: 'Creeper at manageable distance. Strike and sprint backwards before it ignites.'
        };
      }
    }

    if (threat.name === 'skeleton' || threat.name === 'stray' || threat.name === 'bogged') {
      return {
        tactic: 'shield_advance',
        useShield: true,
        shouldRetreat: false,
        reason: 'Ranged skeleton archer. Raise shield to deflect arrows while closing distance.'
      };
    }

    return {
      tactic: 'timed_melee_strike',
      useShield: false,
      shouldRetreat: false,
      reason: `Engage ${threat.name} with weapon cooldown-synchronized melee strikes.`
    };
  }
}

export const defaultThreatAnalyzer = new ThreatAnalyzer();
export default defaultThreatAnalyzer;
