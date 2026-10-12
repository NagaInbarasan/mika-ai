import pathfinderPkg from 'mineflayer-pathfinder';
const { goals, Movements } = pathfinderPkg.default || pathfinderPkg;

/**
 * Deterministic Combat Execution Tactics.
 * Enforces weapon cooldowns, shield blocking against projectiles, health retreat, and kiting.
 */

export class CombatTactics {
  constructor() {
    this.lastAttackTime = 0;
    this.isShieldActive = false;
    this.minRetreatHealth = 8.0; // Retreat when health drops below 8 HP (4 hearts)
  }

  /**
   * Raises shield in offhand to block incoming attacks/projectiles.
   * @param {import('mineflayer').Bot} bot
   * @param {Object} [faceTarget] Entity or position to face towards
   */
  async raiseShield(bot, faceTarget = null) {
    if (!bot) return;

    try {
      // Ensure shield is in offhand
      const shield = bot.inventory?.items()?.find(i => i.name === 'shield');
      if (shield && typeof bot.equip === 'function') {
        await bot.equip(shield, 'off-hand');
      }

      if (faceTarget && faceTarget.position && typeof bot.lookAt === 'function') {
        const p = faceTarget.position.offset ? faceTarget.position.offset(0, 1.5, 0) : faceTarget.position;
        await bot.lookAt(p);
      }

      if (typeof bot.activateItem === 'function') {
        bot.activateItem(true); // true = offhand
        this.isShieldActive = true;
      }
    } catch (err) {
      // Shield raise failed gracefully
    }
  }

  /**
   * Lowers active shield.
   * @param {import('mineflayer').Bot} bot
   */
  lowerShield(bot) {
    if (!bot) return;
    try {
      if (typeof bot.deactivateItem === 'function' && this.isShieldActive) {
        bot.deactivateItem();
        this.isShieldActive = false;
      }
    } catch (err) {}
  }

  /**
   * Executes a single tactical attack honoring weapon attack cooldown.
   * @param {import('mineflayer').Bot} bot
   * @param {Object} targetEntity
   * @param {Object} [options={}]
   * @returns {Promise<Object>} Attack result
   */
  async executeAttack(bot, targetEntity, options = {}) {
    if (!bot || !bot.entity || !targetEntity) {
      return { status: 'failed', error_code: 'INVALID_TARGET', error: 'Target entity unavailable' };
    }

    // Safety check: retreat immediately if health is critical
    if (bot.health !== undefined && bot.health <= this.minRetreatHealth) {
      return await this.executeRetreat(bot, targetEntity);
    }

    const startTime = Date.now();
    const heldWeapon = bot.heldItem ? bot.heldItem.name : '';
    // Minecraft 1.21 weapon swing cooldowns: sword ~625ms (1.6 speed), axe ~1000ms (1.0 speed)
    const cooldownMs = heldWeapon.includes('_axe') ? 1000 : 625;

    const timeSinceLast = Date.now() - this.lastAttackTime;
    if (timeSinceLast < cooldownMs) {
      const waitTime = cooldownMs - timeSinceLast;
      await new Promise(r => setTimeout(r, waitTime));
    }

    try {
      // Lower shield before swinging mainhand
      this.lowerShield(bot);

      // Face target
      if (typeof bot.lookAt === 'function' && targetEntity.position) {
        const eyePos = targetEntity.position.offset ? targetEntity.position.offset(0, 1.4, 0) : targetEntity.position;
        await bot.lookAt(eyePos);
      }

      // Jump for critical hit if safe and on ground
      if (options.criticalHit && bot.entity.onGround && typeof bot.setControlState === 'function') {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 120));
        bot.setControlState('jump', false);
      }

      // Execute attack
      if (typeof bot.attack === 'function') {
        await bot.attack(targetEntity);
        this.lastAttackTime = Date.now();
      }

      // If fighting a creeper or skeleton, immediately raise shield after swinging
      if (targetEntity.name === 'creeper' || targetEntity.name === 'skeleton') {
        await this.raiseShield(bot, targetEntity);
      }

      return {
        status: 'success',
        duration_ms: Date.now() - startTime,
        data: {
          target: targetEntity.name,
          weapon: heldWeapon || 'unarmed',
          cooldown_respected_ms: cooldownMs
        }
      };
    } catch (err) {
      return {
        status: 'failed',
        error_code: 'ATTACK_ERROR',
        error: err.message,
        duration_ms: Date.now() - startTime
      };
    }
  }

  /**
   * Tactical retreat: disengages from threat, retreats to safe distance, and eats food to regenerate.
   * @param {import('mineflayer').Bot} bot
   * @param {Object} [threat]
   * @returns {Promise<Object>} Retreat result
   */
  async executeRetreat(bot, threat = null) {
    if (!bot || !bot.entity) {
      return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
    }

    const startTime = Date.now();
    console.log(`[Combat Tactics] Tactical retreat triggered! HP: ${bot.health}/20`);

    try {
      // 1. Stop any active pvp pursuit
      if (bot.pvp && typeof bot.pvp.stop === 'function') {
        try { bot.pvp.stop(); } catch (_) {}
      }

      // 2. Raise shield while disengaging
      if (threat) {
        await this.raiseShield(bot, threat);
      }

      // 2. Compute retreat vector away from threat
      const botPos = bot.entity.position;
      let retreatX = botPos.x + 12;
      let retreatZ = botPos.z + 12;

      if (threat && threat.position) {
        const diffX = botPos.x - threat.position.x;
        const diffZ = botPos.z - threat.position.z;
        const length = Math.hypot(diffX, diffZ) || 1;
        retreatX = Math.round(botPos.x + (diffX / length) * 16);
        retreatZ = Math.round(botPos.z + (diffZ / length) * 16);

        // Defensive knockback: if threat is in immediate melee reach, strike to knock back
        const targetEnt = threat.entity || threat;
        const distToThreat = typeof botPos.distanceTo === 'function'
          ? botPos.distanceTo(threat.position)
          : Math.hypot(botPos.x - threat.position.x, (botPos.y || 0) - (threat.position.y || 0), botPos.z - threat.position.z);

        if (targetEnt && distToThreat <= 3.2) {
          if (typeof bot.attack === 'function') {
            try {
              if (typeof bot.lookAt === 'function') {
                const targetPos = threat.position.offset ? threat.position.offset(0, 1.4, 0) : threat.position;
                await bot.lookAt(targetPos);
              }
              bot.attack(targetEnt);
            } catch (_) {}
          }
        }
      }

      // 3. Move to retreat waypoint with sprint enabled
      if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') {
        try {
          if (Movements && bot.registry) {
            const defaultMove = new Movements(bot);
            defaultMove.allowSprinting = true;
            if (typeof bot.pathfinder.setMovements === 'function') {
              bot.pathfinder.setMovements(defaultMove);
            }
          }
        } catch (_) {}

        if (typeof bot.setControlState === 'function') {
          bot.setControlState('sprint', true);
        }

        const retreatGoal = goals?.GoalXZ
          ? new goals.GoalXZ(retreatX, retreatZ)
          : (goals ? new goals.GoalNear(retreatX, botPos.y, retreatZ, 2.0) : { x: retreatX, y: botPos.y, z: retreatZ });

        await Promise.race([
          bot.pathfinder.goto(retreatGoal),
          new Promise((_, r) => setTimeout(() => r(new Error('Retreat navigation timeout')), 6000))
        ]).catch(() => {});

        if (typeof bot.setControlState === 'function') {
          bot.setControlState('sprint', false);
        }
      }

      // 4. Consume food if food exists and not full health
      if (bot.food < 20 || bot.health < 20) {
        const food = bot.inventory?.items()?.find(i => ['beef', 'porkchop', 'bread', 'apple', 'cooked_mutton', 'golden_apple'].some(f => i.name.includes(f)));
        if (food && typeof bot.equip === 'function' && typeof bot.consume === 'function') {
          this.lowerShield(bot);
          await bot.equip(food, 'hand');
          await bot.consume().catch(() => {});
        }
      }

      return {
        status: 'success',
        duration_ms: Date.now() - startTime,
        data: {
          action: 'retreat_and_heal',
          final_health: bot.health,
          retreat_target: { x: retreatX, z: retreatZ }
        }
      };
    } catch (err) {
      return {
        status: 'failed',
        error_code: 'RETREAT_ERROR',
        error: err.message,
        duration_ms: Date.now() - startTime
      };
    }
  }
}

export const defaultCombatTactics = new CombatTactics();
export default defaultCombatTactics;
