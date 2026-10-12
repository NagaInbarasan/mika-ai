/**
 * Drop Item Action.
 * Drops specified items from the bot's inventory onto the ground
 * so teammates or nearby bots can collect them.
 */

export async function executeDropItem(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const itemName = args.item;
  const count = args.count || 1;

  if (!itemName) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENTS', error: "Action 'drop_item' requires an 'item' string" };
  }

  const startTime = Date.now();

  // Find item in inventory
  let targetItem = null;
  if (bot.inventory && typeof bot.inventory.items === 'function') {
    const items = bot.inventory.items();
    targetItem = items.find(i => i.name === itemName || i.name.includes(itemName));
  }

  if (!targetItem) {
    return {
      status: 'failed',
      error_code: 'ITEM_NOT_IN_INVENTORY',
      error: `Item '${itemName}' not found in inventory to drop`,
      duration_ms: Date.now() - startTime
    };
  }

  const dropCount = Math.min(count, targetItem.count || 1);

  try {
    if (typeof bot.toss === 'function') {
      await bot.toss(targetItem.type, null, dropCount);
    } else if (typeof bot.tossStack === 'function') {
      await bot.tossStack(targetItem);
    } else {
      // Mock environment fallback
      if (targetItem.count) {
        targetItem.count -= dropCount;
      }
    }

    return {
      status: 'success',
      duration_ms: Date.now() - startTime,
      data: {
        item: targetItem.name || itemName,
        count: dropCount,
        dropped_for: args.teammate || null
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'DROP_ITEM_ERROR',
      error: err.message,
      duration_ms: Date.now() - startTime
    };
  }
}

export default {
  executeDropItem
};
