import pathfinderPkg from 'mineflayer-pathfinder';
const { goals, Movements } = pathfinderPkg.default || pathfinderPkg;
import { harvestTree, isWoodLog } from '../survival/trees.js';

/**
 * Finds, navigates to, and digs a target resource block.
 * Automatically delegates wood/tree collection to the specialized tree harvesting engine.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} args
 * @param {string} args.resource - Resource block name (e.g. 'oak_log', 'dirt', 'wood', 'sand')
 * @param {number} [args.count=1] - Number of items to harvest
 * @param {number} [args.max_distance=16]
 * @param {number} [args.timeout_ms=25000]
 * @returns {Promise<Object>} Execution result
 */
export async function executeCollectResource(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const resourceName = args.resource;
  if (!resourceName) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENTS', error: 'Missing resource name argument' };
  }

  // Delegate wood/tree harvesting to specialized tree engine
  if (resourceName === 'wood' || resourceName === 'tree' || resourceName === 'log' || isWoodLog(resourceName)) {
    return harvestTree(bot, {
      targetLogCount: args.count || 3,
      maxSearchDistance: args.max_distance || 48,
      timeoutMs: args.timeout_ms || 35000,
      preferredTool: args.preferred_tool
    });
  }

  const maxDistance = args.max_distance || 32;
  const timeoutMs = args.timeout_ms || 30000;
  const targetCount = Math.max(1, Math.min(args.count || 1, 8));

  const isStoneQuery = resourceName === 'stone' || resourceName === 'cobblestone';
  const isDirtQuery = resourceName === 'dirt' || resourceName === 'shelter_blocks';

  // Build ID list from registry if available for fast palette matching
  const matchingIds = [];
  if (bot.registry && bot.registry.blocksByName) {
    if (isStoneQuery) {
      for (const name of ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite']) {
        const b = bot.registry.blocksByName[name];
        if (b) matchingIds.push(b.id);
      }
    } else if (isDirtQuery) {
      for (const name of ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'sand']) {
        const b = bot.registry.blocksByName[name];
        if (b) matchingIds.push(b.id);
      }
    } else {
      const b = bot.registry.blocksByName[resourceName];
      if (b) matchingIds.push(b.id);
    }
  }

  const matchesResource = (b) => {
    if (!b) return false;
    if (matchingIds.length > 0 && b.type !== undefined) {
      return matchingIds.includes(b.type);
    }
    if (isStoneQuery) {
      return ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite'].includes(b.name);
    }
    if (isDirtQuery) {
      return ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'sand'].includes(b.name);
    }
    return b.name === resourceName || (b.name && b.name.includes(resourceName));
  };

  const startTime = Date.now();
  let harvestedCount = 0;
  let lastBlockPos = null;

  try {
    for (let i = 0; i < targetCount; i++) {
      // Abort immediately if health is low so tactical survival takes priority
      if (bot.health !== undefined && bot.health <= 8) {
        if (harvestedCount === 0) {
          return {
            status: 'failed',
            error_code: 'HEALTH_CRITICAL',
            error: `Health critical (${bot.health}/20), aborted resource collection to survive`
          };
        }
        break;
      }
    // 1. Find matching block
    let block = null;
    if (typeof bot.findBlock === 'function') {
      const matchCriteria = matchingIds.length > 0 ? matchingIds : matchesResource;
      block = bot.findBlock({
        matching: matchCriteria,
        maxDistance
      });
    }

    if (!block) {
      if (harvestedCount === 0) {
        return {
          status: 'failed',
          error_code: 'RESOURCE_NOT_FOUND',
          error: `No block of type '${resourceName}' found within ${maxDistance} blocks`
        };
      }
      break; // Collected some, no more found
    }

    // 2. Precondition check: verify not unbreakable (bedrock/barrier)
    if (block.hardness !== null && block.hardness < 0) {
      if (harvestedCount === 0) {
        return {
          status: 'failed',
          error_code: 'BLOCK_NOT_HARVESTABLE',
          error: `Block at (${block.position.x}, ${block.position.y}, ${block.position.z}) is unbreakable`
        };
      }
      break;
    }

    // 3. Navigate within reach of the block (range 2.5 blocks)
    const blockPos = block.position;
    lastBlockPos = blockPos;
    const distanceToBlock = bot.entity.position.distanceTo(blockPos);

    if (distanceToBlock > 3.0 && bot.pathfinder) {
      const defaultMove = new Movements(bot);
      defaultMove.canDig = true;
      bot.pathfinder.setMovements(defaultMove);
      const goal = new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 2.5);

      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            bot.pathfinder.stop();
            reject(new Error('Timeout pathfinding to resource block'));
          }, Math.min(timeoutMs - 5000, 15000));

          bot.once('goal_reached', () => {
            clearTimeout(timer);
            resolve();
          });

          bot.once('path_reset', (reason) => {
            if (reason === 'noPath') {
              clearTimeout(timer);
              reject(new Error('No path to resource block'));
            }
          });

          try {
            bot.pathfinder.setGoal(goal);
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });
      } catch (navErr) {
        if (harvestedCount === 0) throw navErr;
        break;
      }
    }

    // 4. Verify harvestable once in reach
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
      if (harvestedCount === 0) {
        return {
          status: 'failed',
          error_code: 'BLOCK_NOT_HARVESTABLE',
          error: `Bot cannot dig block at (${block.position.x}, ${block.position.y}, ${block.position.z})`
        };
      }
      break;
    }



    // 4. Equip suitable tool if available
    if (typeof bot.equip === 'function') {
      const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
      let equippedPreferred = false;
      if (args.preferred_tool) {
        const prefItem = items.find(it => it.name === args.preferred_tool);
        if (prefItem) {
          try {
            await bot.equip(prefItem, 'hand');
            equippedPreferred = true;
          } catch (_) {}
        }
      }

      if (!equippedPreferred) {
        if (block.name.includes('stone') || block.name.includes('ore') || block.name.includes('cobble') || block.name.includes('deepslate')) {
          const pickaxes = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
          for (const p of pickaxes) {
            const it = items.find(it => it.name === p);
            if (it) {
              try { await bot.equip(it, 'hand'); break; } catch (_) {}
            }
          }
        } else if (bot.tool && bot.tool.equipForBlock) {
          try { await bot.tool.equipForBlock(block); } catch (_) {}
        }
      }
    }

    // 5. Dig the block
    if (typeof bot.dig === 'function') {
      await bot.dig(block);
    }
    harvestedCount++;

    // 6. Step slightly towards the broken block position to collect drops
    if (bot.pathfinder) {
      try {
        const dropGoal = new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 0.5);
        bot.pathfinder.setGoal(dropGoal);
        await new Promise(r => setTimeout(r, 1200));
        bot.pathfinder.stop();
      } catch (_) {}
    }
  }

  // If resource collected was food, record food location in persistent memory
  const isFoodResource = ['sweet_berries', 'apple', 'carrot', 'potato', 'melon_slice', 'bread'].includes(resourceName) || resourceName.includes('berries') || resourceName.includes('apple');
  if (isFoodResource && lastBlockPos && bot.memoryStore && typeof bot.memoryStore.recordLocation === 'function') {
    bot.memoryStore.recordLocation('food', {
      x: lastBlockPos.x,
      y: lastBlockPos.y,
      z: lastBlockPos.z
    }, {
      name: `${resourceName} Food Source`,
      food_type: resourceName,
      harvested_count: harvestedCount,
      last_harvested: new Date().toISOString()
    });
  }

  return {
    status: 'success',
    data: {
      resource: resourceName,
      blocks_harvested: harvestedCount,
      block_position: lastBlockPos ? { x: lastBlockPos.x, y: lastBlockPos.y, z: lastBlockPos.z } : null,
      duration_ms: Date.now() - startTime
    }
  };
} catch (err) {
  return {
    status: 'failed',
    error_code: 'COLLECT_FAILED',
    error: err.message,
    duration_ms: Date.now() - startTime
  };
}
}
