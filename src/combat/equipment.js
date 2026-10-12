/**
 * Combat Equipment Manager.
 * Analyzes inventory and equips the highest-tier armor, weapons, and offhand shield.
 */

const ARMOR_TIERS = {
  netherite: 6,
  diamond: 5,
  iron: 4,
  chainmail: 3,
  golden: 2,
  leather: 1
};

const WEAPON_TIERS = {
  netherite_sword: 60,
  diamond_sword: 50,
  iron_sword: 40,
  stone_sword: 30,
  golden_sword: 25,
  wooden_sword: 20,
  netherite_axe: 55,
  diamond_axe: 45,
  iron_axe: 35,
  stone_axe: 25,
  wooden_axe: 15
};

export class EquipmentManager {
  /**
   * Finds the best armor piece for a specific slot.
   * @param {Array} items
   * @param {'helmet'|'chestplate'|'leggings'|'boots'} slotType
   * @returns {Object|null} Best armor item
   */
  getBestArmor(items, slotType) {
    let bestItem = null;
    let highestTier = 0;

    for (const item of items) {
      if (!item.name.endsWith(`_${slotType}`)) continue;
      const material = item.name.split('_')[0];
      const tier = ARMOR_TIERS[material] || 0;
      if (tier > highestTier) {
        highestTier = tier;
        bestItem = item;
      }
    }
    return bestItem;
  }

  /**
   * Finds the best melee weapon in inventory.
   * @param {Array} items
   * @returns {Object|null}
   */
  getBestWeapon(items) {
    let bestWeapon = null;
    let highestScore = 0;

    for (const item of items) {
      const score = WEAPON_TIERS[item.name] || 0;
      if (score > highestScore) {
        highestScore = score;
        bestWeapon = item;
      }
    }
    return bestWeapon;
  }

  /**
   * Evaluates inventory and equips all optimal gear into armor and hand slots.
   * @param {import('mineflayer').Bot} bot
   * @returns {Promise<Object>} Equipment report
   */
  async autoEquip(bot) {
    if (!bot || !bot.inventory) {
      return { status: 'failed', error: 'Bot inventory unavailable' };
    }

    const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
    const equipped = {};

    const slots = [
      { name: 'helmet', dest: 'head' },
      { name: 'chestplate', dest: 'torso' },
      { name: 'leggings', dest: 'legs' },
      { name: 'boots', dest: 'feet' }
    ];

    // 1. Equip Armor
    for (const slot of slots) {
      const best = this.getBestArmor(items, slot.name);
      if (best) {
        try {
          if (typeof bot.equip === 'function') {
            await bot.equip(best, slot.dest);
          }
          equipped[slot.name] = best.name;
        } catch (err) {
          // Continue if equip throws
        }
      }
    }

    // 2. Equip Best Weapon (Main Hand)
    const bestWeapon = this.getBestWeapon(items);
    if (bestWeapon) {
      try {
        if (typeof bot.equip === 'function') {
          await bot.equip(bestWeapon, 'hand');
        }
        equipped.weapon = bestWeapon.name;
      } catch (err) {}
    }

    // 3. Equip Shield (Off Hand)
    const shield = items.find(i => i.name === 'shield');
    if (shield) {
      try {
        if (typeof bot.equip === 'function') {
          await bot.equip(shield, 'off-hand');
        }
        equipped.offhand = 'shield';
      } catch (err) {}
    }

    return {
      status: 'success',
      equipped,
      has_full_armor: Boolean(equipped.helmet && equipped.chestplate && equipped.leggings && equipped.boots),
      has_weapon: Boolean(equipped.weapon),
      has_shield: Boolean(equipped.offhand === 'shield')
    };
  }
}

export const defaultEquipment = new EquipmentManager();
export default defaultEquipment;
