/**
 * Creature Knowledge Database & Learning System for Minecraft Swarm Bots.
 *
 * Provides comprehensive mob intelligence, threat assessment, safe hunting
 * target selection, drop prediction, and dynamic learning through observation.
 */

/**
 * @typedef {'passive' | 'neutral' | 'hostile'} CreatureType
 * @typedef {'melee' | 'melee_careful' | 'shield_close' | 'hit_and_run' | 'avoid' | 'avoid_pack'} HuntStrategy
 * @typedef {'high' | 'medium' | 'low' | 'none'} FoodValue
 *
 * @typedef {Object} CreatureEntry
 * @property {CreatureType} type - Temperament category
 * @property {number} health - Base hit points (HP)
 * @property {string[]} drops - All regular/possible item drops upon death
 * @property {string[]} foodDrops - Subset of drops that are consumable food items
 * @property {string[]} craftDrops - Subset of drops useful for crafting materials
 * @property {number} dangerLevel - Threat rating from 0 (harmless) to 10 (lethal)
 * @property {HuntStrategy} huntStrategy - Recommended tactical combat/engagement strategy
 * @property {FoodValue} foodValue - Sustenance utility rating
 * @property {number} xpValue - Typical experience points dropped on death
 * @property {boolean} [tameable] - Whether the creature can be tamed
 * @property {string} [breedWith] - Primary food item used to breed
 */

/**
 * Static baseline knowledge database of Minecraft creatures.
 * @type {Record<string, CreatureEntry>}
 */
export const CREATURE_DATABASE = {
  // ==========================================
  // PASSIVE CREATURES
  // ==========================================
  cow: {
    type: 'passive',
    health: 10,
    drops: ['raw_beef', 'leather'],
    foodDrops: ['raw_beef'],
    craftDrops: ['leather'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'high',
    xpValue: 2,
    tameable: false,
    breedWith: 'wheat'
  },
  pig: {
    type: 'passive',
    health: 10,
    drops: ['raw_porkchop'],
    foodDrops: ['raw_porkchop'],
    craftDrops: [],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'high',
    xpValue: 2,
    tameable: false,
    breedWith: 'carrot'
  },
  chicken: {
    type: 'passive',
    health: 4,
    drops: ['raw_chicken', 'feather'],
    foodDrops: ['raw_chicken'],
    craftDrops: ['feather'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'medium',
    xpValue: 2,
    tameable: false,
    breedWith: 'wheat_seeds'
  },
  sheep: {
    type: 'passive',
    health: 8,
    drops: ['raw_mutton', 'white_wool'],
    foodDrops: ['raw_mutton'],
    craftDrops: ['white_wool'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'medium',
    xpValue: 2,
    tameable: false,
    breedWith: 'wheat'
  },
  rabbit: {
    type: 'passive',
    health: 3,
    drops: ['raw_rabbit', 'rabbit_hide', 'rabbit_foot'],
    foodDrops: ['raw_rabbit'],
    craftDrops: ['rabbit_hide', 'rabbit_foot'],
    dangerLevel: 0,
    huntStrategy: 'melee_careful',
    foodValue: 'medium',
    xpValue: 2,
    tameable: false,
    breedWith: 'carrot'
  },
  horse: {
    type: 'passive',
    health: 24,
    drops: ['leather'],
    foodDrops: [],
    craftDrops: ['leather'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'none',
    xpValue: 2,
    tameable: true,
    breedWith: 'golden_apple'
  },
  donkey: {
    type: 'passive',
    health: 20,
    drops: ['leather'],
    foodDrops: [],
    craftDrops: ['leather'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'none',
    xpValue: 2,
    tameable: true,
    breedWith: 'golden_apple'
  },
  cod: {
    type: 'passive',
    health: 3,
    drops: ['raw_cod', 'bone_meal'],
    foodDrops: ['raw_cod'],
    craftDrops: ['bone_meal'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'medium',
    xpValue: 2,
    tameable: false
  },
  salmon: {
    type: 'passive',
    health: 3,
    drops: ['raw_salmon', 'bone_meal'],
    foodDrops: ['raw_salmon'],
    craftDrops: ['bone_meal'],
    dangerLevel: 0,
    huntStrategy: 'melee',
    foodValue: 'medium',
    xpValue: 2,
    tameable: false
  },

  // ==========================================
  // NEUTRAL CREATURES
  // ==========================================
  wolf: {
    type: 'neutral',
    health: 8,
    drops: [],
    foodDrops: [],
    craftDrops: [],
    dangerLevel: 4,
    huntStrategy: 'avoid_pack',
    foodValue: 'none',
    xpValue: 2,
    tameable: true,
    breedWith: 'bone'
  },
  bee: {
    type: 'neutral',
    health: 10,
    drops: [],
    foodDrops: [],
    craftDrops: [],
    dangerLevel: 3,
    huntStrategy: 'avoid_pack',
    foodValue: 'none',
    xpValue: 2,
    tameable: false,
    breedWith: 'dandelion'
  },
  iron_golem: {
    type: 'neutral',
    health: 100,
    drops: ['iron_ingot', 'poppy'],
    foodDrops: [],
    craftDrops: ['iron_ingot'],
    dangerLevel: 9,
    huntStrategy: 'avoid',
    foodValue: 'none',
    xpValue: 0,
    tameable: false
  },
  llama: {
    type: 'neutral',
    health: 22,
    drops: ['leather'],
    foodDrops: [],
    craftDrops: ['leather'],
    dangerLevel: 2,
    huntStrategy: 'melee_careful',
    foodValue: 'none',
    xpValue: 2,
    tameable: true,
    breedWith: 'hay_block'
  },
  polar_bear: {
    type: 'neutral',
    health: 30,
    drops: ['raw_cod', 'raw_salmon'],
    foodDrops: ['raw_cod', 'raw_salmon'],
    craftDrops: [],
    dangerLevel: 6,
    huntStrategy: 'avoid',
    foodValue: 'medium',
    xpValue: 3,
    tameable: false
  },
  dolphin: {
    type: 'neutral',
    health: 10,
    drops: ['raw_cod'],
    foodDrops: ['raw_cod'],
    craftDrops: [],
    dangerLevel: 1,
    huntStrategy: 'melee_careful',
    foodValue: 'low',
    xpValue: 0,
    tameable: false
  },
  trader_llama: {
    type: 'neutral',
    health: 22,
    drops: ['leather'],
    foodDrops: [],
    craftDrops: ['leather'],
    dangerLevel: 2,
    huntStrategy: 'melee_careful',
    foodValue: 'none',
    xpValue: 2,
    tameable: false
  },

  // ==========================================
  // HOSTILE CREATURES
  // ==========================================
  zombie: {
    type: 'hostile',
    health: 20,
    drops: ['rotten_flesh', 'iron_ingot', 'carrot', 'potato'],
    foodDrops: ['rotten_flesh', 'carrot', 'potato'],
    craftDrops: ['iron_ingot'],
    dangerLevel: 3,
    huntStrategy: 'melee',
    foodValue: 'low',
    xpValue: 5
  },
  skeleton: {
    type: 'hostile',
    health: 20,
    drops: ['bone', 'arrow'],
    foodDrops: [],
    craftDrops: ['bone', 'arrow'],
    dangerLevel: 5,
    huntStrategy: 'shield_close',
    foodValue: 'none',
    xpValue: 5
  },
  creeper: {
    type: 'hostile',
    health: 20,
    drops: ['gunpowder'],
    foodDrops: [],
    craftDrops: ['gunpowder'],
    dangerLevel: 8,
    huntStrategy: 'hit_and_run',
    foodValue: 'none',
    xpValue: 5
  },
  spider: {
    type: 'hostile',
    health: 16,
    drops: ['string', 'spider_eye'],
    foodDrops: ['spider_eye'],
    craftDrops: ['string', 'spider_eye'],
    dangerLevel: 4,
    huntStrategy: 'melee_careful',
    foodValue: 'low',
    xpValue: 5
  },
  cave_spider: {
    type: 'hostile',
    health: 12,
    drops: ['string', 'spider_eye'],
    foodDrops: ['spider_eye'],
    craftDrops: ['string', 'spider_eye'],
    dangerLevel: 6,
    huntStrategy: 'melee_careful',
    foodValue: 'low',
    xpValue: 5
  },
  enderman: {
    type: 'hostile',
    health: 40,
    drops: ['ender_pearl'],
    foodDrops: [],
    craftDrops: ['ender_pearl'],
    dangerLevel: 7,
    huntStrategy: 'shield_close',
    foodValue: 'none',
    xpValue: 5
  },
  witch: {
    type: 'hostile',
    health: 26,
    drops: ['glass_bottle', 'glowstone_dust', 'gunpowder', 'redstone', 'spider_eye', 'sugar', 'stick'],
    foodDrops: ['sugar', 'spider_eye'],
    craftDrops: ['glass_bottle', 'glowstone_dust', 'gunpowder', 'redstone', 'spider_eye', 'sugar', 'stick'],
    dangerLevel: 6,
    huntStrategy: 'hit_and_run',
    foodValue: 'none',
    xpValue: 5
  },
  drowned: {
    type: 'hostile',
    health: 20,
    drops: ['rotten_flesh', 'copper_ingot', 'nautilus_shell'],
    foodDrops: ['rotten_flesh'],
    craftDrops: ['copper_ingot', 'nautilus_shell'],
    dangerLevel: 5,
    huntStrategy: 'melee_careful',
    foodValue: 'low',
    xpValue: 5
  },
  husk: {
    type: 'hostile',
    health: 20,
    drops: ['rotten_flesh', 'iron_ingot'],
    foodDrops: ['rotten_flesh'],
    craftDrops: ['iron_ingot'],
    dangerLevel: 4,
    huntStrategy: 'melee_careful',
    foodValue: 'low',
    xpValue: 5
  },
  stray: {
    type: 'hostile',
    health: 20,
    drops: ['bone', 'arrow'],
    foodDrops: [],
    craftDrops: ['bone', 'arrow'],
    dangerLevel: 5,
    huntStrategy: 'shield_close',
    foodValue: 'none',
    xpValue: 5
  },
  phantom: {
    type: 'hostile',
    health: 20,
    drops: ['phantom_membrane'],
    foodDrops: [],
    craftDrops: ['phantom_membrane'],
    dangerLevel: 5,
    huntStrategy: 'hit_and_run',
    foodValue: 'none',
    xpValue: 5
  },
  pillager: {
    type: 'hostile',
    health: 24,
    drops: ['arrow', 'crossbow'],
    foodDrops: [],
    craftDrops: ['arrow', 'crossbow'],
    dangerLevel: 6,
    huntStrategy: 'shield_close',
    foodValue: 'none',
    xpValue: 5
  },
  vindicator: {
    type: 'hostile',
    health: 24,
    drops: ['emerald', 'iron_axe'],
    foodDrops: [],
    craftDrops: ['emerald', 'iron_axe'],
    dangerLevel: 7,
    huntStrategy: 'hit_and_run',
    foodValue: 'none',
    xpValue: 5
  },
  ravager: {
    type: 'hostile',
    health: 100,
    drops: ['saddle'],
    foodDrops: [],
    craftDrops: ['saddle'],
    dangerLevel: 9,
    huntStrategy: 'avoid',
    foodValue: 'none',
    xpValue: 20
  },
  blaze: {
    type: 'hostile',
    health: 20,
    drops: ['blaze_rod'],
    foodDrops: [],
    craftDrops: ['blaze_rod'],
    dangerLevel: 7,
    huntStrategy: 'shield_close',
    foodValue: 'none',
    xpValue: 10
  },
  ghast: {
    type: 'hostile',
    health: 10,
    drops: ['ghast_tear', 'gunpowder'],
    foodDrops: [],
    craftDrops: ['ghast_tear', 'gunpowder'],
    dangerLevel: 7,
    huntStrategy: 'hit_and_run',
    foodValue: 'none',
    xpValue: 5
  },
  magma_cube: {
    type: 'hostile',
    health: 16,
    drops: ['magma_cream'],
    foodDrops: [],
    craftDrops: ['magma_cream'],
    dangerLevel: 5,
    huntStrategy: 'melee_careful',
    foodValue: 'none',
    xpValue: 4
  },
  slime: {
    type: 'hostile',
    health: 16,
    drops: ['slime_ball'],
    foodDrops: [],
    craftDrops: ['slime_ball'],
    dangerLevel: 3,
    huntStrategy: 'melee',
    foodValue: 'none',
    xpValue: 4
  },
  silverfish: {
    type: 'hostile',
    health: 8,
    drops: [],
    foodDrops: [],
    craftDrops: [],
    dangerLevel: 4,
    huntStrategy: 'avoid_pack',
    foodValue: 'none',
    xpValue: 5
  },
  guardian: {
    type: 'hostile',
    health: 30,
    drops: ['prismarine_shard', 'prismarine_crystals', 'raw_cod'],
    foodDrops: ['raw_cod'],
    craftDrops: ['prismarine_shard', 'prismarine_crystals'],
    dangerLevel: 7,
    huntStrategy: 'shield_close',
    foodValue: 'medium',
    xpValue: 10
  },
  elder_guardian: {
    type: 'hostile',
    health: 80,
    drops: ['prismarine_shard', 'prismarine_crystals', 'wet_sponge', 'raw_cod'],
    foodDrops: ['raw_cod'],
    craftDrops: ['prismarine_shard', 'prismarine_crystals', 'wet_sponge'],
    dangerLevel: 9,
    huntStrategy: 'avoid',
    foodValue: 'medium',
    xpValue: 10
  },
  warden: {
    type: 'hostile',
    health: 500,
    drops: ['sculk_catalyst'],
    foodDrops: [],
    craftDrops: ['sculk_catalyst'],
    dangerLevel: 10,
    huntStrategy: 'avoid',
    foodValue: 'none',
    xpValue: 5
  },
  wither_skeleton: {
    type: 'hostile',
    health: 20,
    drops: ['coal', 'bone', 'wither_skeleton_skull'],
    foodDrops: [],
    craftDrops: ['coal', 'bone', 'wither_skeleton_skull'],
    dangerLevel: 8,
    huntStrategy: 'hit_and_run',
    foodValue: 'none',
    xpValue: 5
  }
};

/**
 * Numeric scores used to compare FoodValue categories.
 */
const FOOD_VALUE_SCORES = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0
};

/**
 * Creature Knowledge and Learning System.
 * Queries mob stats, hunting recommendations, and tracks dynamic drops observed during play.
 */
export class CreatureKnowledge {
  /**
   * @param {Record<string, CreatureEntry>} [database=CREATURE_DATABASE] - Optional database override
   */
  constructor(database = CREATURE_DATABASE) {
    this.database = database;
    /** @type {Map<string, Set<string>>} */
    this.learned = new Map();
  }

  /**
   * Retrieves static knowledge entry for a creature.
   * @param {string} name - Entity name (e.g. 'cow', 'zombie')
   * @returns {CreatureEntry|null}
   */
  getCreature(name) {
    if (!name || typeof name !== 'string') return null;
    return this.database[name.toLowerCase()] || null;
  }

  /**
   * Checks if a creature is huntable for sustenance (passive with food drops).
   * @param {string} name
   * @returns {boolean}
   */
  isHuntable(name) {
    const creature = this.getCreature(name);
    if (!creature) return false;
    return creature.type === 'passive' && Array.isArray(creature.foodDrops) && creature.foodDrops.length > 0;
  }

  /**
   * Checks if a creature is intrinsically hostile.
   * @param {string} name
   * @returns {boolean}
   */
  isHostile(name) {
    const creature = this.getCreature(name);
    return creature ? creature.type === 'hostile' : false;
  }

  /**
   * Evaluates if a creature poses a significant threat relative to bot health.
   * Defined as: dangerLevel > 5 OR (dangerLevel > 3 AND botHealth < 10).
   * @param {string} name
   * @param {number} [botHealth=20] - Current bot hit points
   * @returns {boolean}
   */
  isDangerous(name, botHealth = 20) {
    const creature = this.getCreature(name);
    if (!creature) return false;
    const { dangerLevel } = creature;
    return dangerLevel > 5 || (dangerLevel > 3 && botHealth < 10);
  }

  /**
   * Gets list of huntable creatures safe for the bot to engage given current health.
   * Sorted in ascending order of dangerLevel, then descending order of foodValue.
   * @param {number} [botHealth=20]
   * @returns {string[]} Array of creature names
   */
  getSafeHuntTargets(botHealth = 20) {
    const safeTargets = [];

    for (const [name] of Object.entries(this.database)) {
      if (this.isHuntable(name) && !this.isDangerous(name, botHealth)) {
        safeTargets.push(name);
      }
    }

    return safeTargets.sort((a, b) => {
      const entryA = this.database[a];
      const entryB = this.database[b];

      // Primary sort: lowest danger first
      if (entryA.dangerLevel !== entryB.dangerLevel) {
        return entryA.dangerLevel - entryB.dangerLevel;
      }

      // Secondary sort: highest food value first
      const foodA = FOOD_VALUE_SCORES[entryA.foodValue] || 0;
      const foodB = FOOD_VALUE_SCORES[entryB.foodValue] || 0;
      return foodB - foodA;
    });
  }

  /**
   * Retrieves categorized drops for a creature combining database knowledge and learned drops.
   * @param {string} name
   * @returns {{ food: string[], craft: string[], all: string[] }}
   */
  getDropsForCreature(name) {
    const creature = this.getCreature(name);
    const learnedDrops = this.getLearnedDrops(name);

    if (!creature && learnedDrops.size === 0) {
      return { food: [], craft: [], all: [] };
    }

    const food = creature?.foodDrops ? [...creature.foodDrops] : [];
    const craft = creature?.craftDrops ? [...creature.craftDrops] : [];
    const allSet = new Set(creature?.drops || []);

    for (const drop of learnedDrops) {
      allSet.add(drop);
    }

    return {
      food,
      craft,
      all: Array.from(allSet)
    };
  }

  /**
   * Returns recommended hunting or combat strategy for creature.
   * @param {string} name
   * @returns {HuntStrategy|'avoid'}
   */
  getHuntStrategy(name) {
    const creature = this.getCreature(name);
    return creature ? creature.huntStrategy : 'avoid';
  }

  /**
   * Returns creature name with the highest foodValue rating.
   * Ties broken by lowest dangerLevel and base health.
   * @returns {string|null}
   */
  getBestFoodSource() {
    let bestCreature = null;
    let highestScore = -1;
    let lowestDanger = Infinity;

    for (const [name, entry] of Object.entries(this.database)) {
      if (!this.isHuntable(name)) continue;

      const score = FOOD_VALUE_SCORES[entry.foodValue] || 0;
      if (score > highestScore) {
        highestScore = score;
        lowestDanger = entry.dangerLevel;
        bestCreature = name;
      } else if (score === highestScore) {
        if (entry.dangerLevel < lowestDanger) {
          lowestDanger = entry.dangerLevel;
          bestCreature = name;
        }
      }
    }

    return bestCreature;
  }

  /**
   * Records observed drops into the learned memory Map.
   * @param {string} name
   * @param {string[]} observedDrops
   * @returns {Set<string>} Updated set of observed drops for the creature
   */
  learnCreature(name, observedDrops = []) {
    if (!name || typeof name !== 'string') return new Set();
    const key = name.toLowerCase();

    if (!this.learned.has(key)) {
      this.learned.set(key, new Set());
    }

    const set = this.learned.get(key);
    for (const item of observedDrops) {
      if (item && typeof item === 'string') {
        set.add(item);
      }
    }

    return set;
  }

  /**
   * Retrieves all learned (observed) drops for a creature.
   * @param {string} name
   * @returns {Set<string>}
   */
  getLearnedDrops(name) {
    if (!name || typeof name !== 'string') return new Set();
    const set = this.learned.get(name.toLowerCase());
    return set ? new Set(set) : new Set();
  }

  /**
   * Finds all creature names known to drop a specific item, checking both static DB and learned observations.
   * @param {string} dropName
   * @returns {string[]}
   */
  getCreaturesByDrop(dropName) {
    if (!dropName || typeof dropName !== 'string') return [];
    const target = dropName.toLowerCase();
    const results = new Set();

    // Check static database
    for (const [name, entry] of Object.entries(this.database)) {
      if (Array.isArray(entry.drops) && entry.drops.some((d) => d.toLowerCase() === target)) {
        results.add(name);
      }
    }

    // Check dynamically learned drops
    for (const [name, dropSet] of this.learned.entries()) {
      for (const d of dropSet) {
        if (d.toLowerCase() === target) {
          results.add(name);
        }
      }
    }

    return Array.from(results);
  }
}

/**
 * Singleton instance of CreatureKnowledge with standard database.
 * @type {CreatureKnowledge}
 */
export const defaultCreatureKnowledge = new CreatureKnowledge();
export default defaultCreatureKnowledge;
