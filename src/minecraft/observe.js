import { defaultShelterManager } from '../survival/shelter.js';

/**
 * Collects a bounded, compact observation of the Minecraft world and bot state.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} options
 * @returns {Object} Compact observation record
 */
export function collectObservation(bot, options = {}) {
  if (!bot || !bot.entity) {
    return { error: 'Bot entity not ready' };
  }

  const maxEntityDistance = options.maxEntityDistance || 16;
  const maxBlockDistance = options.maxBlockDistance || 8;

  // 1. Bot State
  const pos = bot.entity.position;
  const state = {
    position: {
      x: Math.round(pos.x * 10) / 10,
      y: Math.round(pos.y * 10) / 10,
      z: Math.round(pos.z * 10) / 10
    },
    yaw: Math.round(bot.entity.yaw * 100) / 100,
    pitch: Math.round(bot.entity.pitch * 100) / 100,
    health: bot.health !== undefined ? Math.round(bot.health * 10) / 10 : 20,
    food: bot.food !== undefined ? bot.food : 20,
    saturation: bot.foodSaturation !== undefined ? Math.round(bot.foodSaturation * 10) / 10 : 0,
    oxygen: bot.oxygenLevel !== undefined ? bot.oxygenLevel : 20,
    isAlive: bot.health > 0
  };

  // 2. Environment & Daylight Cycle
  const timeOfDay = bot.time ? bot.time.timeOfDay : null;
  let timePhase = 'day';
  if (timeOfDay !== null) {
    if (timeOfDay >= 0 && timeOfDay < 6000) timePhase = 'morning';
    else if (timeOfDay >= 6000 && timeOfDay < 9000) timePhase = 'midday';
    else if (timeOfDay >= 9000 && timeOfDay < 12000) timePhase = 'afternoon_prepare_shelter';
    else if (timeOfDay >= 12000 && timeOfDay < 13000) timePhase = 'dusk_sunset';
    else if (timeOfDay >= 13000 && timeOfDay < 23000) timePhase = 'night_dangerous';
    else timePhase = 'dawn';
  }

  const isDay = timeOfDay !== null ? timeOfDay < 13000 || timeOfDay > 23000 : true;

  const environment = {
    dimension: bot.game ? bot.game.dimension : 'overworld',
    gameMode: bot.game ? bot.game.gameMode : 'survival',
    time: timeOfDay,
    time_of_day: timeOfDay,
    timePhase,
    isDay,
    is_night: !isDay,
    isRaining: bot.isRaining || false
  };

  // 3. Inventory & Equipment Summary
  const inventory = [];
  if (bot.inventory) {
    const items = bot.inventory.items();
    for (const item of items) {
      inventory.push({
        name: item.name,
        count: item.count,
        slot: item.slot
      });
    }
  }

  // Equipment (held items, armor)
  const equipment = {
    mainhand: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
    offhand: bot.inventory?.slots?.[45] ? { name: bot.inventory.slots[45].name, count: bot.inventory.slots[45].count } : null,
    helmet: bot.inventory?.slots?.[5] ? { name: bot.inventory.slots[5].name } : null,
    chestplate: bot.inventory?.slots?.[6] ? { name: bot.inventory.slots[6].name } : null,
    leggings: bot.inventory?.slots?.[7] ? { name: bot.inventory.slots[7].name } : null,
    boots: bot.inventory?.slots?.[8] ? { name: bot.inventory.slots[8].name } : null
  };

  // Task & Status Tracking
  const taskState = {
    current_task: bot.currentTask || null,
    recent_action_status: bot.recentActionStatus || null
  };

  // 4. Nearby Entities (Filtered within radius)
  const nearbyEntities = [];
  const nearbyThreats = [];
  const botPos = bot.entity.position;

  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!entity || entity === bot.entity || !entity.position) continue;

    const dist = typeof botPos.distanceTo === 'function'
      ? botPos.distanceTo(entity.position)
      : Math.hypot(botPos.x - entity.position.x, botPos.y - entity.position.y, botPos.z - entity.position.z);
    if (dist <= maxEntityDistance) {
      const summary = {
        name: entity.name || entity.username || 'unknown',
        type: entity.type,
        distance: Math.round(dist * 10) / 10,
        position: {
          x: Math.round(entity.position.x * 10) / 10,
          y: Math.round(entity.position.y * 10) / 10,
          z: Math.round(entity.position.z * 10) / 10
        }
      };

      nearbyEntities.push(summary);

      // Classify threats (hostile mobs)
      const hostileTypes = ['zombie', 'husk', 'parched', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'drowned', 'phantom', 'pillager', 'slime'];
      if (entity.name && hostileTypes.includes(entity.name.toLowerCase())) {
        nearbyThreats.push(summary);
      }
    }
  }

  // 5. Significant Nearby Blocks / Resources (within radius)
  const nearbyResources = [];
  const valuableBlockNames = [
    'oak_log', 'birch_log', 'spruce_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
    'cactus', 'dead_bush', 'sand', 'sandstone', 'smooth_sandstone', 'cut_sandstone',
    'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore',
    'crafting_table', 'furnace', 'chest', 'water'
  ];

  try {
    const foundBlocks = bot.findBlocks({
      matching: (block) => block && valuableBlockNames.includes(block.name),
      maxDistance: maxBlockDistance,
      count: 10
    });

    for (const blockVec of foundBlocks) {
      const block = bot.blockAt(blockVec);
      if (block) {
        nearbyResources.push({
          name: block.name,
          distance: Math.round(botPos.distanceTo(blockVec) * 10) / 10,
          position: { x: blockVec.x, y: blockVec.y, z: blockVec.z }
        });
      }
    }
  } catch (err) {
    // findBlocks might fail if chunks are not yet loaded
  }

  // 6. Shelter Safety Assessment
  let shelterSafety = null;
  if (bot.mockShelterState) {
    shelterSafety = {
      safe: Boolean(bot.mockShelterState.safe ?? (bot.mockShelterState.hasRoof && bot.mockShelterState.wallCoverage >= 3)),
      hasRoof: Boolean(bot.mockShelterState.hasRoof),
      wallCoverage: typeof bot.mockShelterState.wallCoverage === 'number' ? bot.mockShelterState.wallCoverage : 4,
      reason: 'Mock shelter state'
    };
  } else if (defaultShelterManager && typeof defaultShelterManager.verifyShelterSafety === 'function') {
    try {
      shelterSafety = defaultShelterManager.verifyShelterSafety(bot);
    } catch (_) {
      shelterSafety = { safe: false, reason: 'Shelter evaluation error' };
    }
  } else {
    shelterSafety = { safe: false, reason: 'No shelter evaluation' };
  }

  // 7. Known Spatial Locations and Last Death Information from Persistent Memory
  let knownLocations = null;
  let lastDeath = null;
  if (bot.memoryStore && typeof bot.memoryStore.getKnownLocationsSummary === 'function') {
    knownLocations = bot.memoryStore.getKnownLocationsSummary();
    lastDeath = bot.memoryStore.getLastDeathInfo();
  }

  return {
    timestamp: new Date().toISOString(),
    agent: state,
    environment,
    inventory,
    equipment,
    task: taskState,
    nearby_entities: nearbyEntities.slice(0, 8),
    nearby_threats: nearbyThreats,
    nearby_resources: nearbyResources.slice(0, 10),
    shelter_safety: shelterSafety,
    known_locations: knownLocations,
    last_death: lastDeath
  };
}

