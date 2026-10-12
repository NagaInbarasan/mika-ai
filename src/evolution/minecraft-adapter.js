/**
 * Minecraft Action & Observation Adapter for Evolved Policies
 * E:\MIKA\src\evolution\minecraft-adapter.js
 *
 * Bridges the headless accelerated artificial-life survival policies with
 * the Mineflayer bot action execution engine and real-time environment observations.
 */

import { ACTIONS, RECIPES } from './world.js';
import { ACTION_DEFINITIONS, extractFeatures } from './policy.js';

/**
 * Standard resource categories mapped from real Minecraft items
 */
export const RESOURCE_CATEGORIES = Object.freeze({
  WOOD: 'WOOD',
  STONE: 'STONE',
  FOOD: 'FOOD',
  IRON: 'IRON',
  COAL: 'COAL'
});

/**
 * Minecraft item names mapped to simplified resource buckets
 */
const ITEM_TO_RESOURCE_MAP = {
  // Wood items
  oak_log: 'WOOD',
  birch_log: 'WOOD',
  spruce_log: 'WOOD',
  jungle_log: 'WOOD',
  acacia_log: 'WOOD',
  dark_oak_log: 'WOOD',
  mangrove_log: 'WOOD',
  cherry_log: 'WOOD',
  crimson_stem: 'WOOD',
  warped_stem: 'WOOD',
  oak_planks: 'WOOD',
  birch_planks: 'WOOD',
  spruce_planks: 'WOOD',
  jungle_planks: 'WOOD',
  acacia_planks: 'WOOD',
  dark_oak_planks: 'WOOD',
  mangrove_planks: 'WOOD',
  cherry_planks: 'WOOD',
  stick: 'WOOD',

  // Stone items
  stone: 'STONE',
  cobblestone: 'STONE',
  deepslate: 'STONE',
  cobbled_deepslate: 'STONE',
  andesite: 'STONE',
  diorite: 'STONE',
  granite: 'STONE',
  tuff: 'STONE',
  blackstone: 'STONE',
  sandstone: 'STONE',

  // Iron items
  raw_iron: 'IRON',
  iron_ingot: 'IRON',
  iron_nugget: 'IRON',
  iron_ore: 'IRON',
  deepslate_iron_ore: 'IRON',

  // Coal items
  coal: 'COAL',
  charcoal: 'COAL',
  coal_ore: 'COAL',
  deepslate_coal_ore: 'COAL',

  // Food items
  apple: 'FOOD',
  bread: 'FOOD',
  beef: 'FOOD',
  cooked_beef: 'FOOD',
  porkchop: 'FOOD',
  cooked_porkchop: 'FOOD',
  chicken: 'FOOD',
  cooked_chicken: 'FOOD',
  mutton: 'FOOD',
  cooked_mutton: 'FOOD',
  salmon: 'FOOD',
  cooked_salmon: 'FOOD',
  cod: 'FOOD',
  cooked_cod: 'FOOD',
  carrot: 'FOOD',
  golden_carrot: 'FOOD',
  potato: 'FOOD',
  baked_potato: 'FOOD',
  sweet_berries: 'FOOD',
  glow_berries: 'FOOD',
  melon_slice: 'FOOD',
  cookie: 'FOOD',
  beetroot: 'FOOD',
  mushroom_stew: 'FOOD'
};

/**
 * Recognized hostile mob entities that constitute threats
 */
const HOSTILE_MOB_NAMES = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'wither_skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'phantom',
  'pillager',
  'vindicator',
  'evoker',
  'ravager',
  'slime',
  'magma_cube',
  'blaze',
  'ghast',
  'hoglin',
  'piglin_brute',
  'warden',
  'silverfish',
  'endermite',
  'guardian',
  'elder_guardian'
]);

/**
 * MinecraftAdapter bridges evolved simulation policies to real Mineflayer bot execution.
 */
export class MinecraftAdapter {
  /**
   * @param {object} [policy] - Evolved policy instance (e.g. from policy.js or evolution.js)
   */
  constructor(policy = null) {
    this.policy = policy;
  }

  /**
   * Categorizes a Mineflayer item name into a simplified simulation resource category.
   *
   * @param {string} itemName
   * @returns {string|null} RESOURCE_CATEGORIES member or null if unmapped
   */
  classifyItem(itemName) {
    if (!itemName || typeof itemName !== 'string') return null;
    const lower = itemName.toLowerCase().trim();

    if (ITEM_TO_RESOURCE_MAP[lower]) {
      return ITEM_TO_RESOURCE_MAP[lower];
    }

    if (lower.includes('log') || lower.includes('plank') || lower.includes('wood')) {
      return RESOURCE_CATEGORIES.WOOD;
    }
    if (lower.includes('stone') || lower.includes('deepslate') || lower.includes('cobble')) {
      return RESOURCE_CATEGORIES.STONE;
    }
    if (lower.includes('iron')) {
      return RESOURCE_CATEGORIES.IRON;
    }
    if (lower.includes('coal')) {
      return RESOURCE_CATEGORIES.COAL;
    }
    if (
      lower.includes('cooked') ||
      lower.includes('meat') ||
      lower.includes('berry') ||
      lower.includes('stew') ||
      lower.includes('soup')
    ) {
      return RESOURCE_CATEGORIES.FOOD;
    }

    return null;
  }

  /**
   * Aggregates real Minecraft inventory items into simplified resource categories.
   *
   * @param {Array<{name: string, count: number}>} inventoryItems
   * @returns {{ WOOD: number, STONE: number, FOOD: number, IRON: number, COAL: number, raw: Map<string, number> }}
   */
  aggregateInventory(inventoryItems = []) {
    const counts = {
      WOOD: 0,
      STONE: 0,
      FOOD: 0,
      IRON: 0,
      COAL: 0,
      raw: new Map()
    };

    if (!Array.isArray(inventoryItems)) {
      return counts;
    }

    for (const item of inventoryItems) {
      if (!item || !item.name) continue;
      const itemCount = typeof item.count === 'number' ? item.count : 1;
      counts.raw.set(item.name, (counts.raw.get(item.name) || 0) + itemCount);

      const category = this.classifyItem(item.name);
      if (category && counts[category] !== undefined) {
        counts[category] += itemCount;
      }
    }

    return counts;
  }

  /**
   * Filters and counts hostile mob threats from observation entity lists.
   *
   * @param {object} mineflayerObservation
   * @returns {Array<{ name: string, distance: number, position: object }>}
   */
  detectThreats(mineflayerObservation = {}) {
    const threats = [];

    // 1. Direct nearbyThreats array if already extracted by observe.js
    if (Array.isArray(mineflayerObservation.nearbyThreats)) {
      for (const t of mineflayerObservation.nearbyThreats) {
        threats.push({
          name: t.name || 'hostile',
          distance: typeof t.distance === 'number' ? t.distance : 8,
          position: t.position || null
        });
      }
      return threats;
    }

    // 2. Scan nearbyEntities if nearbyThreats is empty or not present
    if (Array.isArray(mineflayerObservation.nearbyEntities)) {
      for (const entity of mineflayerObservation.nearbyEntities) {
        if (!entity || !entity.name) continue;
        const nameLower = entity.name.toLowerCase();
        if (HOSTILE_MOB_NAMES.has(nameLower) || entity.type === 'hostile' || entity.type === 'mob') {
          threats.push({
            name: entity.name,
            distance: typeof entity.distance === 'number' ? entity.distance : 8,
            position: entity.position || null
          });
        }
      }
    }

    return threats;
  }

  /**
   * Translates a Mineflayer observation object (from src/minecraft/observe.js)
   * into the 19-element feature vector format compatible with policy.selectAction().
   *
   * @param {object} mineflayerObservation
   * @returns {Float64Array} Feature vector compatible with policy.selectAction()
   */
  translateObservation(mineflayerObservation = {}) {
    const agent = mineflayerObservation.agent || {};
    const env = mineflayerObservation.environment || {};

    // 1. Bot vital stats
    const health = typeof agent.health === 'number' ? agent.health : 20;
    const food = typeof agent.food === 'number' ? agent.food : 20;
    const maxHealth = 20;
    const maxFood = 20;

    const healthNorm = Math.max(0, Math.min(1, health / maxHealth));
    const foodNorm = Math.max(0, Math.min(1, food / maxFood));

    // 2. Day / night cycle
    let isNight = 0;
    if (env.is_night !== undefined) {
      isNight = env.is_night ? 1 : 0;
    } else if (env.isDay !== undefined) {
      isNight = env.isDay ? 0 : 1;
    } else if (typeof env.time === 'number') {
      isNight = (env.time >= 13000 && env.time <= 23000) ? 1 : 0;
    }

    // 3. Inventory classification
    const inventoryItems = Array.isArray(mineflayerObservation.inventory)
      ? mineflayerObservation.inventory
      : [];
    const resourceCounts = this.aggregateInventory(inventoryItems);

    const hasWood = resourceCounts.WOOD > 0 ? 1 : 0;
    const hasStone = resourceCounts.STONE > 0 ? 1 : 0;
    const hasFood = resourceCounts.FOOD > 0 ? 1 : 0;
    const hasIron = resourceCounts.IRON > 0 ? 1 : 0;

    // 4. Nearby threats
    const threats = this.detectThreats(mineflayerObservation);
    const threatCountNorm = Math.min(5, threats.length) / 5;

    // 5. Nearby resources (blocks)
    const nearbyBlocks = Array.isArray(mineflayerObservation.nearbyResources)
      ? mineflayerObservation.nearbyResources
      : [];
    const resourceCountNorm = Math.min(10, nearbyBlocks.length) / 10;

    // 6. Cell state heuristics
    // Current block at feet / head or immediate vicinity
    const currentCellHasResource = nearbyBlocks.some((r) => r.distance != null && r.distance <= 1.5) ? 1 : 0;
    const currentCellHasThreat = threats.some((t) => t.distance != null && t.distance <= 2.5) ? 1 : 0;

    // 7. Shelter state
    const shelterSafety = mineflayerObservation.shelterSafety || {};
    const hasShelter = (shelterSafety.safe || shelterSafety.hasRoof) ? 1 : 0;
    const shelterDistNorm = hasShelter ? 0 : 0.5;

    // 8. Tool identification
    const toolsHeld = new Set();
    const equipment = mineflayerObservation.equipment || {};
    if (equipment.mainhand?.name) toolsHeld.add(equipment.mainhand.name);
    if (equipment.offhand?.name) toolsHeld.add(equipment.offhand.name);
    for (const item of inventoryItems) {
      if (item?.name?.includes('pickaxe') || item?.name?.includes('sword')) {
        toolsHeld.add(item.name);
      }
    }

    const hasPickaxe = Array.from(toolsHeld).some((t) => t.includes('pickaxe')) ? 1 : 0;
    const hasSword = Array.from(toolsHeld).some((t) => t.includes('sword')) ? 1 : 0;

    // 9. Craftability evaluation
    const canCraftAnything = (
      resourceCounts.WOOD >= 3 || // wooden pickaxe
      (resourceCounts.STONE >= 3 && resourceCounts.WOOD >= 2) || // stone pickaxe
      resourceCounts.WOOD >= 2 || // wooden sword
      (resourceCounts.STONE >= 2 && resourceCounts.WOOD >= 1) // stone sword
    ) ? 1 : 0;

    // 10. Urgencies
    const foodUrgency = Math.max(0, Math.min(1, 1 - foodNorm));
    const healthUrgency = Math.max(0, Math.min(1, 1 - healthNorm));
    const tickProgress = 0.5; // Neutral default for steady-state live play

    // 11. Populate 19-dimensional feature vector
    const features = new Float64Array(19);
    features[0] = healthNorm;
    features[1] = foodNorm;
    features[2] = isNight;
    features[3] = resourceCountNorm;
    features[4] = threatCountNorm;
    features[5] = hasWood;
    features[6] = hasStone;
    features[7] = hasFood;
    features[8] = hasIron;
    features[9] = currentCellHasResource;
    features[10] = currentCellHasThreat;
    features[11] = hasShelter;
    features[12] = shelterDistNorm;
    features[13] = hasPickaxe;
    features[14] = hasSword;
    features[15] = canCraftAnything;
    features[16] = foodUrgency;
    features[17] = healthUrgency;
    features[18] = tickProgress;

    // Attach supplementary metadata for inspection / debugging
    features.metadata = {
      resourceCounts,
      threatCount: threats.length,
      threats,
      isNight: Boolean(isNight),
      health,
      food,
      hasPickaxe: Boolean(hasPickaxe),
      hasSword: Boolean(hasSword)
    };

    return features;
  }

  /**
   * Translates a policy action output into a valid Mineflayer action proposal.
   *
   * Compatible with src/actions/index.js and ALLOWED_ACTIONS schema.
   *
   * @param {object|string} policyAction - Output from policy.selectAction() or policy.act()
   * @param {object} [mineflayerObservation={}] - Optional current observation for spatial context
   * @returns {{ action: string, arguments: object, goal: string, reason_summary: string }}
   */
  translateAction(policyAction, mineflayerObservation = {}) {
    let actionName = ACTIONS.IDLE;
    let craftTarget = null;

    if (typeof policyAction === 'string') {
      actionName = policyAction;
    } else if (policyAction && typeof policyAction === 'object') {
      actionName = policyAction.actionName || policyAction.action || ACTIONS.IDLE;
      craftTarget = policyAction.craftTarget || policyAction.target || null;
    }

    const botPos = mineflayerObservation.agent?.position || { x: 0, y: 64, z: 0 };
    const nearbyThreats = this.detectThreats(mineflayerObservation);
    const nearbyResources = Array.isArray(mineflayerObservation.nearbyResources)
      ? mineflayerObservation.nearbyResources
      : [];

    switch (actionName) {
      case ACTIONS.MOVE_NORTH:
        return {
          action: 'navigate_to',
          arguments: {
            x: Math.round(botPos.x),
            z: Math.round(botPos.z - 4)
          },
          goal: 'Navigate north to explore territory',
          reason_summary: 'Evolved policy selected MOVE_NORTH to scout or reposition northward'
        };

      case ACTIONS.MOVE_SOUTH:
        return {
          action: 'navigate_to',
          arguments: {
            x: Math.round(botPos.x),
            z: Math.round(botPos.z + 4)
          },
          goal: 'Navigate south to explore territory',
          reason_summary: 'Evolved policy selected MOVE_SOUTH to scout or reposition southward'
        };

      case ACTIONS.MOVE_EAST:
        return {
          action: 'navigate_to',
          arguments: {
            x: Math.round(botPos.x + 4),
            z: Math.round(botPos.z)
          },
          goal: 'Navigate east to explore territory',
          reason_summary: 'Evolved policy selected MOVE_EAST to scout or reposition eastward'
        };

      case ACTIONS.MOVE_WEST:
        return {
          action: 'navigate_to',
          arguments: {
            x: Math.round(botPos.x - 4),
            z: Math.round(botPos.z)
          },
          goal: 'Navigate west to explore territory',
          reason_summary: 'Evolved policy selected MOVE_WEST to scout or reposition westward'
        };

      case ACTIONS.GATHER: {
        let resourceType = 'wood';
        if (nearbyResources.length > 0 && nearbyResources[0].name) {
          const firstBlock = nearbyResources[0].name.toLowerCase();
          if (firstBlock.includes('stone') || firstBlock.includes('deepslate')) {
            resourceType = 'stone';
          } else if (firstBlock.includes('coal')) {
            resourceType = 'coal';
          } else if (firstBlock.includes('iron')) {
            resourceType = 'iron';
          }
        }
        return {
          action: 'collect_resource',
          arguments: {
            resource: resourceType,
            count: 3
          },
          goal: `Harvest nearby ${resourceType}`,
          reason_summary: 'Evolved policy selected GATHER to replenish survival material inventory'
        };
      }

      case ACTIONS.EAT_RAW:
      case ACTIONS.EAT_COOKED: {
        const inv = Array.isArray(mineflayerObservation.inventory) ? mineflayerObservation.inventory : [];
        const foodItem = inv.find((i) => this.classifyItem(i?.name) === RESOURCE_CATEGORIES.FOOD);
        const itemName = foodItem ? foodItem.name : 'bread';

        return {
          action: 'eat_food',
          arguments: {
            item: itemName
          },
          goal: 'Consume food to restore hunger and health',
          reason_summary: 'Evolved policy selected eating to sustain biological vitality'
        };
      }

      case ACTIONS.CRAFT: {
        const targetItem = craftTarget || 'wooden_pickaxe';
        return {
          action: 'craft_item',
          arguments: {
            item: targetItem,
            count: 1
          },
          goal: `Craft ${targetItem}`,
          reason_summary: `Evolved policy selected CRAFT for equipment progression (${targetItem})`
        };
      }

      case ACTIONS.BUILD_SHELTER:
        return {
          action: 'place_block',
          arguments: {
            block: 'dirt',
            x: Math.round(botPos.x),
            y: Math.round(botPos.y),
            z: Math.round(botPos.z + 1)
          },
          goal: 'Construct defensive enclosure',
          reason_summary: 'Evolved policy selected BUILD_SHELTER to fortify position against night threats'
        };

      case ACTIONS.GOTO_SHELTER: {
        const shelterPos = mineflayerObservation.knownLocations?.shelter || {
          x: Math.round(botPos.x),
          z: Math.round(botPos.z)
        };
        return {
          action: 'navigate_to',
          arguments: {
            x: shelterPos.x,
            z: shelterPos.z
          },
          goal: 'Return to safe shelter position',
          reason_summary: 'Evolved policy selected GOTO_SHELTER to avoid environmental hazards'
        };
      }

      case ACTIONS.FLEE:
        return {
          action: 'retreat_and_heal',
          arguments: {
            reason: 'Evading nearby hostile threats'
          },
          goal: 'Disengage and retreat to safe distance',
          reason_summary: 'Evolved policy selected FLEE to avoid fatal mob combat encounters'
        };

      case ACTIONS.ATTACK: {
        const targetName = nearbyThreats.length > 0 ? nearbyThreats[0].name : 'zombie';
        return {
          action: 'attack_target',
          arguments: {
            target: targetName
          },
          goal: `Neutralize threat (${targetName})`,
          reason_summary: 'Evolved policy selected ATTACK to eliminate hostile threat in proximity'
        };
      }

      case ACTIONS.IDLE:
      default:
        return {
          action: 'look_around',
          arguments: {
            duration: 1000
          },
          goal: 'Observe immediate environment',
          reason_summary: 'Evolved policy selected IDLE / ambient environmental observation'
        };
    }
  }

  /**
   * Executes the full translation pipeline:
   * translateObservation → policy.selectAction (or policy.act) → translateAction.
   *
   * @param {object} mineflayerObservation
   * @returns {{ action: string, arguments: object, goal: string, reason_summary: string }} Action proposal
   */
  generatePlan(mineflayerObservation = {}) {
    if (!this.policy) {
      return this.translateAction({ actionName: ACTIONS.IDLE }, mineflayerObservation);
    }

    const featureVector = this.translateObservation(mineflayerObservation);

    let policyAction;
    try {
      if (typeof this.policy.selectAction === 'function') {
        policyAction = this.policy.selectAction(featureVector);
      } else if (typeof this.policy.act === 'function') {
        policyAction = this.policy.act(mineflayerObservation);
      } else if (typeof this.policy.decide === 'function') {
        policyAction = this.policy.decide(mineflayerObservation);
      } else {
        policyAction = ACTIONS.IDLE;
      }
    } catch (err) {
      policyAction = ACTIONS.IDLE;
    }

    return this.translateAction(policyAction, mineflayerObservation);
  }
}

export default MinecraftAdapter;
