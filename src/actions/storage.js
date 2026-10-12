/**
 * Storage and Chest Management Actions.
 * Supports opening nearby chests, depositing surplus resources, and withdrawing supplies.
 */

export async function executeStoreInChest(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const itemsToKeep = args.keep_items || ['sword', 'pickaxe', 'axe', 'shield', 'bread', 'cooked_beef', 'apple'];
  const minFoodToKeep = args.min_food_to_keep || 6;

  // 1. Locate nearby chest block
  const targetPoint = (args.x !== undefined && args.z !== undefined)
    ? { x: args.x, y: args.y !== undefined ? args.y : bot.entity.position.y, z: args.z }
    : bot.entity.position;

  const chestBlock = typeof bot.findBlock === 'function' ? bot.findBlock({
    matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
    maxDistance: args.max_distance || 6
  }) : null;

  if (!chestBlock) {
    return {
      status: 'failed',
      error_code: 'NO_CHEST_NEARBY',
      error: 'No chest or container found within 6 blocks to store resources'
    };
  }

  const startTime = Date.now();

  try {
    let chest = null;
    if (typeof bot.openChest === 'function') {
      chest = await bot.openChest(chestBlock);
    } else if (typeof bot.openContainer === 'function') {
      chest = await bot.openContainer(chestBlock);
    }

    if (!chest) {
      return { status: 'failed', error_code: 'CONTAINER_OPEN_FAILED', error: 'Failed to open container interface' };
    }

    const deposited = [];
    const category = args.category ? String(args.category).toLowerCase() : null;

    // Transfer surplus items
    const botItems = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
    for (const item of botItems) {
      const isEssentialTool = itemsToKeep.some(k => item.name.includes(k));
      if (isEssentialTool) continue; // Keep tools and weapons on agent

      // Filter by category if requested
      if (category === 'food') {
        const isFood = ['wheat', 'bread', 'carrot', 'potato', 'beef', 'porkchop', 'chicken', 'mutton', 'apple', 'sweet_berries'].some(f => item.name.includes(f));
        if (!isFood) continue;
      } else if (category === 'minerals' || category === 'armory') {
        const isMineral = ['stone', 'cobblestone', 'coal', 'iron', 'copper', 'gold', 'diamond', 'flint', 'leather', 'wool', 'raw_iron', 'raw_copper', 'ingot'].some(m => item.name.includes(m));
        if (!isMineral) continue;
      } else if (category === 'building') {
        const isBuilding = ['dirt', 'cobblestone', 'wood', 'log', 'planks', 'stone', 'gravel', 'sand'].some(b => item.name.includes(b));
        if (!isBuilding) continue;
      }

      try {
        if (typeof chest.deposit === 'function') {
          await chest.deposit(item.type, null, item.count);
          deposited.push(`${item.name} x${item.count}`);
        }
      } catch (depErr) {
        // Slot might be full, continue
      }
    }

    if (typeof chest.close === 'function') {
      chest.close();
    }

    return {
      status: 'success',
      duration_ms: Date.now() - startTime,
      data: {
        container: chestBlock.name,
        deposited_items: deposited,
        total_types_deposited: deposited.length
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'STORE_CHEST_ERROR',
      error: err.message,
      duration_ms: Date.now() - startTime
    };
  }
}

export async function executeWithdrawFromChest(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const targetItem = args.item;
  const count = args.count || 1;

  if (!targetItem) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENTS', error: "Action requires 'item' argument" };
  }

  const chestBlock = typeof bot.findBlock === 'function' ? bot.findBlock({
    matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
    maxDistance: 6
  }) : null;

  if (!chestBlock) {
    return { status: 'failed', error_code: 'NO_CHEST_NEARBY', error: 'No chest container nearby' };
  }

  const startTime = Date.now();
  try {
    const chest = typeof bot.openChest === 'function' ? await bot.openChest(chestBlock) : null;
    if (!chest) {
      return { status: 'failed', error_code: 'CONTAINER_OPEN_FAILED', error: 'Could not open chest' };
    }

    const containerItem = chest.containerItems().find(i => i.name === targetItem || i.name.includes(targetItem));
    if (!containerItem) {
      chest.close();
      return { status: 'failed', error_code: 'ITEM_NOT_IN_CHEST', error: `Item '${targetItem}' not found in chest` };
    }

    const withdrawCount = Math.min(count, containerItem.count);
    if (typeof chest.withdraw === 'function') {
      await chest.withdraw(containerItem.type, null, withdrawCount);
    }
    chest.close();

    return {
      status: 'success',
      duration_ms: Date.now() - startTime,
      data: {
        withdrawn_item: containerItem.name,
        count: withdrawCount
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'WITHDRAW_CHEST_ERROR',
      error: err.message,
      duration_ms: Date.now() - startTime
    };
  }
}

export default {
  executeStoreInChest,
  executeWithdrawFromChest
};
