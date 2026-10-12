/**
 * Progression Stage Definitions & Explicit Unlock Prerequisites.
 * 
 * 1. Farmer: gather resources, maintain food, craft tools, store resources in chests.
 * 2. Warrior: equip suitable armor, shield, sword and bow; fight basic enemies; retreat & recover.
 * 3. Adventurer: prepare for Nether, blaze rods & ender pearls, Eyes of Ender, locate stronghold.
 * 4. Dragon Slayer: End entry, crystal destruction, avoid dragon attacks, victory verification.
 */

export const STAGES = {
  FARMER: 'farmer',
  WARRIOR: 'warrior',
  ADVENTURER: 'adventurer',
  DRAGON_SLAYER: 'dragon_slayer'
};

export const STAGE_CONFIG = {
  [STAGES.FARMER]: {
    id: STAGES.FARMER,
    order: 1,
    title: 'Farmer & Gatherer',
    description: 'Gather essential resources, cultivate crops, craft initial tools, and establish secure chest storage.',
    requiredTools: ['pickaxe', 'axe', 'sword'],
    unlockRequirements: {
      description: 'Default initial survival stage.'
    },
    nextStage: STAGES.WARRIOR,
    prerequisitesForNext: [
      {
        id: 'food_reserve',
        description: 'Maintain surplus food supply (>= 16 edible food items)',
        check: (stats, obs) => {
          const foodCount = countEdibleFood(obs);
          return foodCount >= 16;
        }
      },
      {
        id: 'basic_tools',
        description: 'Craft basic set of tools (pickaxe, axe, and sword in inventory)',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const hasPickaxe = inv.some(i => i.name.includes('_pickaxe'));
          const hasAxe = inv.some(i => i.name.includes('_axe'));
          const hasSword = inv.some(i => i.name.includes('_sword'));
          return hasPickaxe && hasAxe && hasSword;
        }
      },
      {
        id: 'defense_equipment',
        description: 'Acquire at least a shield or one piece of armor (helmet, chestplate, leggings, or boots)',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const eq = obs?.equipment || {};
          const hasShield = inv.some(i => i.name === 'shield') || eq.offhand?.name === 'shield';
          const hasArmor = inv.some(i => isArmorItem(i.name)) ||
            Boolean(eq.helmet || eq.chestplate || eq.leggings || eq.boots);
          return hasShield || hasArmor;
        }
      }
    ]
  },

  [STAGES.WARRIOR]: {
    id: STAGES.WARRIOR,
    order: 2,
    title: 'Warrior',
    description: 'Equip armor, shield, sword, and bow. Engage and defeat hostile mobs with tactical attack cooldowns, shield defense, and health retreat.',
    unlockRequirements: {
      food_reserve: 16,
      basic_tools: ['pickaxe', 'axe', 'sword'],
      defense_item: 'shield or armor piece'
    },
    nextStage: STAGES.ADVENTURER,
    prerequisitesForNext: [
      {
        id: 'combat_kills',
        description: 'Defeat at least 5 hostile mobs without death',
        check: (stats) => (stats?.mobs_killed_total || 0) >= 5
      },
      {
        id: 'full_armor_equipped',
        description: 'Equip a full set of armor (helmet, chestplate, leggings, boots)',
        check: (stats, obs) => {
          const eq = obs?.equipment || {};
          return Boolean(eq.helmet && eq.chestplate && eq.leggings && eq.boots);
        }
      },
      {
        id: 'shield_and_weapons',
        description: 'Equip shield in offhand and have both melee (sword) and ranged (bow + arrows)',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const eq = obs?.equipment || {};
          const hasShield = eq.offhand?.name === 'shield' || inv.some(i => i.name === 'shield');
          const hasSword = inv.some(i => i.name.includes('_sword')) || eq.mainhand?.name?.includes('_sword');
          const hasBow = inv.some(i => i.name === 'bow') || eq.mainhand?.name === 'bow';
          const hasArrows = inv.some(i => i.name === 'arrow' && i.count >= 8);
          return Boolean(hasShield && hasSword && hasBow && hasArrows);
        }
      },
      {
        id: 'nether_readiness',
        description: 'Acquire >= 10 obsidian blocks and flint & steel for Nether portal ignition',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const obsidianCount = (inv.find(i => i.name === 'obsidian')?.count) || 0;
          const hasFlint = inv.some(i => i.name === 'flint_and_steel');
          return obsidianCount >= 10 && hasFlint;
        }
      }
    ]
  },

  [STAGES.ADVENTURER]: {
    id: STAGES.ADVENTURER,
    order: 3,
    title: 'Nether Adventurer & Stronghold Explorer',
    description: 'Traverse the Nether, defeat blazes for blaze rods, trade/hunt for ender pearls, craft Eyes of Ender, and track down the End Stronghold.',
    unlockRequirements: {
      combat_kills: 5,
      full_armor: true,
      shield_and_ranged: true,
      nether_readiness: '10 obsidian + flint_and_steel'
    },
    nextStage: STAGES.DRAGON_SLAYER,
    prerequisitesForNext: [
      {
        id: 'blaze_rods',
        description: 'Collect at least 6 blaze rods from Nether fortresses',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const rods = (inv.find(i => i.name === 'blaze_rod')?.count) || 0;
          return rods >= 6 || (stats?.blaze_rods_collected || 0) >= 6;
        }
      },
      {
        id: 'ender_pearls',
        description: 'Acquire at least 12 ender pearls from endermen or bartering',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const pearls = (inv.find(i => i.name === 'ender_pearl')?.count) || 0;
          return pearls >= 12 || (stats?.ender_pearls_collected || 0) >= 12;
        }
      },
      {
        id: 'eyes_of_ender',
        description: 'Craft at least 12 Eyes of Ender',
        check: (stats, obs) => {
          const inv = obs?.inventory || [];
          const eyes = (inv.find(i => i.name === 'ender_eye')?.count) || 0;
          return eyes >= 12 || (stats?.eyes_of_ender_crafted || 0) >= 12;
        }
      },
      {
        id: 'stronghold_located',
        description: 'Locate the End Portal frame room in the Stronghold',
        check: (stats) => Boolean(stats?.stronghold_located)
      }
    ]
  },

  [STAGES.DRAGON_SLAYER]: {
    id: STAGES.DRAGON_SLAYER,
    order: 4,
    title: 'Dragon Slayer (Boss Encounter)',
    description: 'Enter the End dimension, destroy healing End Crystals with bow/pillars, evade dragon breath and charge attacks, strike during perching windows, and verify victory.',
    unlockRequirements: {
      eyes_of_ender: 12,
      stronghold_portal_activated: true,
      end_dimension_ready: true
    },
    nextStage: null,
    prerequisitesForNext: []
  }
};

/**
 * Helper to count edible food items in observation inventory.
 */
export function countEdibleFood(obs) {
  if (!obs || !obs.inventory) return 0;
  const foodKeywords = ['beef', 'porkchop', 'mutton', 'chicken', 'bread', 'apple', 'carrot', 'potato', 'cookie', 'melon_slice', 'golden_apple'];
  let count = 0;
  for (const item of obs.inventory) {
    if (item.name && foodKeywords.some(k => item.name.includes(k))) {
      count += (item.count || 1);
    }
  }
  return count;
}

/**
 * Helper to check if item name is armor.
 */
export function isArmorItem(name) {
  if (!name) return false;
  return name.includes('_helmet') || name.includes('_chestplate') || name.includes('_leggings') || name.includes('_boots');
}

export default {
  STAGES,
  STAGE_CONFIG,
  countEdibleFood,
  isArmorItem
};
