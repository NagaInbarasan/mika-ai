/**
 * Ender Dragon Special Boss Encounter Controller.
 * 
 * Mechanics:
 * 1. Crystal Phase: Detect and destroy healing End Crystals with bow/arrows or pillar ascent.
 * 2. Evasion Phase: Evade dragon breath clouds and charging dive-attacks.
 * 3. Perch Phase: Strike dragon during perching attack windows at the central bedrock exit portal.
 * 4. Victory Verification: Detect dragon defeat, exit portal opening, and trophy collection.
 */

export class DragonFightController {
  constructor() {
    this.exitPortalCenter = { x: 0, y: 65, z: 0 };
    this.crystalsDestroyed = 0;
    this.dragonDefeated = false;
  }

  /**
   * Scans for remaining healing End Crystals on the obsidian pillars.
   * @param {import('mineflayer').Bot} bot
   * @returns {Array<Object>} List of active End Crystals
   */
  findEndCrystals(bot) {
    if (!bot || !bot.entities) return [];

    const crystals = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e && (e.name === 'end_crystal' || e.name === 'EnderCrystal')) {
        crystals.push({
          id: e.id,
          name: 'end_crystal',
          position: e.position,
          distance: bot.entity ? e.position.distanceTo(bot.entity.position) : 0,
          entity: e
        });
      }
    }

    crystals.sort((a, b) => a.distance - b.distance);
    return crystals;
  }

  /**
   * Finds the Ender Dragon entity and evaluates its current combat state.
   * @param {import('mineflayer').Bot} bot
   * @returns {Object|null} Dragon state snapshot
   */
  getDragonState(bot) {
    if (!bot || !bot.entities) return null;

    let dragonEntity = null;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e && (e.name === 'ender_dragon' || e.name === 'EnderDragon')) {
        dragonEntity = e;
        break;
      }
    }

    if (!dragonEntity) return null;

    const botPos = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
    const distToBot = dragonEntity.position.distanceTo(botPos);
    const distToCenter = Math.hypot(dragonEntity.position.x - this.exitPortalCenter.x, dragonEntity.position.z - this.exitPortalCenter.z);

    // If dragon is within 10 blocks of central portal and at lower Y, it is in perching phase!
    const isPerching = distToCenter < 12.0 && dragonEntity.position.y <= (this.exitPortalCenter.y + 12);

    return {
      entity: dragonEntity,
      position: dragonEntity.position,
      health: dragonEntity.health !== undefined ? dragonEntity.health : 200,
      distanceToBot: Math.round(distToBot * 10) / 10,
      isPerching,
      isCharging: distToBot < 18.0 && !isPerching
    };
  }

  /**
   * Recommends the optimal tactical action based on the dragon fight phase.
   * @param {import('mineflayer').Bot} bot
   * @returns {Object} Tactical directive
   */
  evaluateDragonTactics(bot) {
    const crystals = this.findEndCrystals(bot);
    const dragonState = this.getDragonState(bot);

    // 1. Crystal Phase: Destroy crystals first so dragon cannot heal
    if (crystals.length > 0) {
      const targetCrystal = crystals[0];
      const hasBow = bot.inventory?.items()?.some(i => i.name === 'bow');
      const hasArrows = bot.inventory?.items()?.some(i => i.name === 'arrow');

      if (hasBow && hasArrows && targetCrystal.distance <= 45) {
        return {
          phase: 'crystal_destruction_ranged',
          priority: 'critical',
          target: targetCrystal,
          recommended_action: 'shoot_crystal',
          directive: `Shoot End Crystal at distance ${targetCrystal.distance.toFixed(1)}m using bow and arrow.`
        };
      } else {
        return {
          phase: 'crystal_destruction_approach',
          priority: 'high',
          target: targetCrystal,
          recommended_action: 'navigate_to',
          directive: `Approach obsidian pillar to destroy End Crystal. Remaining crystals: ${crystals.length}.`
        };
      }
    }

    // 2. Perch Attack Window: Dragon is landing on central portal!
    if (dragonState && dragonState.isPerching) {
      return {
        phase: 'perch_melee_attack_window',
        priority: 'maximum_damage_window',
        target: dragonState.entity,
        recommended_action: 'attack_target',
        directive: 'ATTACK WINDOW OPEN: Ender Dragon is perching on central portal! Strike with sword/axe from behind head.'
      };
    }

    // 3. Charge / Breath Evasion
    if (dragonState && dragonState.isCharging) {
      return {
        phase: 'charge_evasion',
        priority: 'evade_danger',
        target: dragonState.entity,
        recommended_action: 'defend_with_shield',
        directive: 'Dragon is diving/charging towards agent! Raise shield or strafe laterally behind an obsidian pillar.'
      };
    }

    // 4. Default: Safe Positioning
    return {
      phase: 'standby_and_evade',
      priority: 'moderate',
      target: dragonState ? dragonState.entity : null,
      recommended_action: 'look_around',
      directive: 'Dragon is circling overhead. Maintain distance from center, monitor breath clouds, and await perching window.'
    };
  }
}

export const defaultDragonFight = new DragonFightController();
export default defaultDragonFight;
