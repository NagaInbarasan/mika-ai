import { Vec3 } from 'vec3';

/**
 * Validates recipes and crafts items, identifying specific missing ingredients.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} args
 * @param {string} args.item - Name of item to craft (e.g. 'oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe')
 * @param {number} [args.count=1] - Number of crafting cycles
 * @returns {Promise<Object>} Execution result
 */
export async function executeCraftItem(bot, args = {}) {
  if (!bot || !bot.inventory) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot is not ready' };
  }

  let resolvedItem = args.item;
  if (!resolvedItem) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENTS', error: 'Missing item name to craft' };
  }

  // Normalize common aliases and typos
  const norm = resolvedItem.toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (norm === 'ptck_axe' || norm === 'pickaxe' || norm === 'ptckaxe' || norm === 'pick_axe' || norm === 'wooden_pick') {
    resolvedItem = 'wooden_pickaxe';
  } else if (norm === 'stone_pick') {
    resolvedItem = 'stone_pickaxe';
  } else if (norm === 'table' || norm === 'workbench') {
    resolvedItem = 'crafting_table';
  } else {
    resolvedItem = norm;
  }

  // Resolve generic 'planks' to specific plank variant based on logs in inventory
  if (resolvedItem === 'planks') {
    const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
    const log = items.find(i => i.name && i.name.includes('_log'));
    if (log) {
      resolvedItem = log.name.replace('_log', '_planks');
    } else {
      const existingPlanks = items.find(i => i.name && i.name.includes('_planks'));
      resolvedItem = existingPlanks ? existingPlanks.name : 'oak_planks';
    }
  }

  const itemName = resolvedItem;
  const count = args.count || 1;

  // Resolve item definition
  const itemDef = bot.registry ? bot.registry.itemsByName[resolvedItem] : null;
  if (!itemDef) {
    return {
      status: 'failed',
      error_code: 'UNKNOWN_ITEM',
      error: `Item '${resolvedItem}' is not recognized in Minecraft registry`
    };
  }

  // Helper functions for table placement
  function isPlaceableAt(block) {
    if (!block) return false;
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return true;
    const n = block.name.toLowerCase();
    if (n === 'grass_block' || n.includes('dirt') || n.includes('stone') || n.includes('log') || n.includes('wood') || n.includes('plank')) {
      return false;
    }
    if (block.boundingBox === 'empty') return true;
    return (
      n === 'short_grass' ||
      n === 'grass' ||
      n === 'tall_grass' ||
      n === 'seagrass' ||
      n === 'fern' ||
      n === 'large_fern' ||
      n === 'dead_bush' ||
      n.includes('flower') ||
      n.includes('tulip') ||
      n.includes('rose') ||
      n.includes('orchid') ||
      n.includes('allium') ||
      n.includes('dandelion') ||
      n.includes('poppy') ||
      n.includes('bush') ||
      n === 'snow'
    );
  }

  function isSolidSupport(block) {
    if (!block) return false;
    const n = block.name.toLowerCase();
    if (
      n === 'air' ||
      n.includes('air') ||
      n === 'water' ||
      n === 'lava' ||
      n.includes('leaves') ||
      n === 'short_grass' ||
      n === 'grass' ||
      n === 'tall_grass' ||
      n === 'seagrass' ||
      n.includes('flower') ||
      n.includes('fern') ||
      block.boundingBox === 'empty'
    ) {
      return false;
    }
    return true;
  }

  // Check for nearby crafting table (within 3.8 blocks)
  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  let craftingTableBlock = typeof bot.findBlock === 'function' ? bot.findBlock({
    matching: tableId ? [tableId] : ((b) => b && (b.name === 'crafting_table' || b.name === 'workbench')),
    maxDistance: 3.8
  }) : null;

  // If table is needed but unplaced, check if bot has crafting_table item to place
  if (!craftingTableBlock && typeof bot.placeBlock === 'function' && typeof bot.blockAt === 'function') {
    const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
    const tableItem = items.find(i => i.name === 'crafting_table');
    if (tableItem && bot.entity && bot.entity.position) {
      const botFloor = bot.entity.position.floored();
      const botPos = bot.entity.position;
      const candidateDests = [];

      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dz === 0) continue;
          for (let dy = -1; dy <= 1; dy++) {
            candidateDests.push(botFloor.offset(dx, dy, dz));
          }
        }
      }

      // Sort by distance to bot so we pick the closest suitable spot
      candidateDests.sort((a, b) => {
        const da = botPos.distanceTo(a.offset(0.5, 0.5, 0.5));
        const db = botPos.distanceTo(b.offset(0.5, 0.5, 0.5));
        return da - db;
      });

      let chosenRef = null;
      let chosenDest = null;

      for (const dest of candidateDests) {
        const destBlock = bot.blockAt(dest);
        const belowBlock = bot.blockAt(dest.offset(0, -1, 0));

        if (!isPlaceableAt(destBlock) || !isSolidSupport(belowBlock)) {
          continue;
        }

        // Avoid self-collision: ensure bot's AABB does not intersect destination block
        const collidesWithBot = (
          botPos.x + 0.35 > dest.x &&
          botPos.x - 0.35 < dest.x + 1 &&
          botPos.z + 0.35 > dest.z &&
          botPos.z - 0.35 < dest.z + 1 &&
          botPos.y + 1.85 > dest.y &&
          botPos.y < dest.y + 1
        );

        const distToBot = botPos.distanceTo(dest.offset(0.5, 0.5, 0.5));
        if (!collidesWithBot && distToBot >= 1.0 && distToBot <= 3.8) {
          chosenRef = belowBlock;
          chosenDest = dest;
          break;
        }
      }

      if (chosenRef) {
        try {
          if (typeof bot.equip === 'function') await bot.equip(tableItem, 'hand');
          if (typeof bot.lookAt === 'function') await bot.lookAt(chosenDest.offset(0.5, 0.5, 0.5));
          await bot.placeBlock(chosenRef, new Vec3(0, 1, 0));
          await new Promise(r => setTimeout(r, 600));
          const placedBlock = bot.blockAt(chosenDest);
          if (placedBlock && (placedBlock.name === 'crafting_table' || placedBlock.name === 'workbench')) {
            craftingTableBlock = placedBlock;
          } else {
            craftingTableBlock = bot.findBlock ? bot.findBlock({
              matching: tableId ? [tableId] : ((b) => b && (b.name === 'crafting_table' || b.name === 'workbench')),
              maxDistance: 4.5
            }) : null;
          }
        } catch (placeErr) {
          console.warn('[Crafting] Table auto-place warning:', placeErr.message);
        }
      }
    }
  }

  // If table block exists but bot is a bit far, orient towards it
  if (craftingTableBlock && typeof bot.lookAt === 'function') {
    try {
      await bot.lookAt(craftingTableBlock.position.offset(0.5, 0.5, 0.5));
    } catch (_) {}
  }

  // Query recipes
  // recipesFor(itemType, metadata, minResultCount, craftingTable)
  const recipes = typeof bot.recipesFor === 'function' ? bot.recipesFor(itemDef.id, null, 1, craftingTableBlock) : [];

  if (!recipes || recipes.length === 0) {
    // If no recipes are available, check if recipes exist without considering current inventory to report missing ingredients
    const allRecipes = bot.recipesAll ? bot.recipesAll(itemDef.id, null, craftingTableBlock) : [];
    
    if (allRecipes.length === 0) {
      // Check if it requires a crafting table that isn't nearby
      const tableRecipes = bot.recipesAll ? bot.recipesAll(itemDef.id, null, true) : [];
      if (tableRecipes.length > 0 && !craftingTableBlock) {
        return {
          status: 'failed',
          error_code: 'CRAFTING_TABLE_REQUIRED',
          error: `Crafting '${itemName}' requires a crafting table, but none is within reach`
        };
      }
    }

    return {
      status: 'failed',
      error_code: 'MISSING_INGREDIENTS',
      error: `Missing prerequisite ingredients to craft '${itemName}'`
    };
  }

  const recipe = recipes[0];

  try {
    await bot.craft(recipe, count, craftingTableBlock);
    return {
      status: 'success',
      data: {
        crafted_item: itemName,
        count
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'CRAFT_EXECUTION_ERROR',
      error: err.message
    };
  }
}
