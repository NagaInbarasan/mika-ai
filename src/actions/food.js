/**
 * Finds food in inventory, equips it, and eats to restore health/food points.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} args
 * @param {string} [args.food_name] - Optional specific food to eat
 * @param {number} [args.timeout_ms=10000]
 * @returns {Promise<Object>} Execution result
 */
export async function executeEatFood(bot, args = {}) {
  if (!bot || !bot.inventory) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot is not ready' };
  }

  // Precondition: check if bot is already full (Minecraft prevents eating at food 20 unless golden apple)
  if (bot.food !== undefined && bot.food >= 20) {
    return {
      status: 'failed',
      error_code: 'NOT_HUNGRY',
      error: 'Bot food level is already at maximum (20/20)'
    };
  }

  const commonFoods = [
    'cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
    'golden_apple', 'bread', 'baked_potato', 'cooked_salmon', 'cooked_cod',
    'apple', 'carrot', 'sweet_berries', 'melon_slice'
  ];

  // Find candidate food
  const items = bot.inventory.items();
  let foodItem = null;

  if (args.food_name) {
    foodItem = items.find(i => i.name === args.food_name);
    if (!foodItem) {
      return {
        status: 'failed',
        error_code: 'FOOD_NOT_IN_INVENTORY',
        error: `Specified food '${args.food_name}' was not found in inventory`
      };
    }
  } else {
    // Pick the best available food
    for (const foodName of commonFoods) {
      foodItem = items.find(i => i.name === foodName);
      if (foodItem) break;
    }

    if (!foodItem) {
      // Check for any item with food in name
      foodItem = items.find(i => i.name.includes('apple') || i.name.includes('bread') || i.name.includes('cooked'));
    }
  }

  if (!foodItem) {
    return {
      status: 'failed',
      error_code: 'NO_FOOD_AVAILABLE',
      error: 'No edible food items found in inventory'
    };
  }

  try {
    // Equip food to hand
    await bot.equip(foodItem, 'hand');
    // Consume food
    await bot.consume();

    return {
      status: 'success',
      data: {
        consumed_item: foodItem.name,
        final_food: bot.food,
        final_health: bot.health
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'EAT_FAILED',
      error: err.message
    };
  }
}
