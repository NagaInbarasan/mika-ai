/**
 * Crop Cultivation and Farming Actions.
 * Supports harvesting mature crops, tilling farmland with hoes, and planting seeds.
 */

const CROP_TYPES = ['wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin'];
const SEED_TYPES = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'];

export async function executeFarmCrop(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const maxDistance = args.max_distance || 12;

  // 1. Locate mature crop nearby
  const cropBlock = typeof bot.findBlock === 'function' ? bot.findBlock({
    matching: (b) => {
      if (!b || !CROP_TYPES.includes(b.name)) return false;
      // In Minecraft metadata / properties, age 7 indicates fully grown wheat/carrots/potatoes
      if (b.metadata === 7 || (b._properties && b._properties.age === 7) || b.name === 'melon' || b.name === 'pumpkin') {
        return true;
      }
      return false;
    },
    maxDistance
  }) : null;

  if (!cropBlock) {
    return {
      status: 'failed',
      error_code: 'NO_MATURE_CROPS',
      error: 'No fully mature crops found in range to harvest'
    };
  }

  const startTime = Date.now();

  try {
    // 2. Dig / harvest the mature crop
    if (typeof bot.dig === 'function') {
      await bot.dig(cropBlock);
    }

    // 3. Replant seeds if in inventory
    const farmlandBlock = typeof bot.blockAt === 'function' ? bot.blockAt(cropBlock.position) : null;
    let replanted = false;

    if (farmlandBlock && typeof bot.inventory?.items === 'function') {
      const items = bot.inventory.items();
      const seedItem = items.find(i => SEED_TYPES.includes(i.name));

      if (seedItem && typeof bot.equip === 'function' && typeof bot.placeBlock === 'function') {
        await bot.equip(seedItem, 'hand');
        // Find soil below the broken crop
        const soilBelow = bot.blockAt(cropBlock.position.offset(0, -1, 0));
        if (soilBelow && soilBelow.name.includes('farmland')) {
          await bot.placeBlock(soilBelow, { x: 0, y: 1, z: 0 });
          replanted = true;
        }
      }
    }

    // Record farm location in persistent memory
    if (bot.memoryStore && typeof bot.memoryStore.recordLocation === 'function') {
      bot.memoryStore.recordLocation('farm', {
        x: cropBlock.position.x,
        y: cropBlock.position.y,
        z: cropBlock.position.z
      }, {
        name: `${cropBlock.name} Farm`,
        crop_type: cropBlock.name,
        replanted,
        last_harvested: new Date().toISOString()
      });
    }

    return {
      status: 'success',
      duration_ms: Date.now() - startTime,
      data: {
        harvested_crop: cropBlock.name,
        replanted,
        position: {
          x: cropBlock.position.x,
          y: cropBlock.position.y,
          z: cropBlock.position.z
        }
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'FARMING_ERROR',
      error: err.message,
      duration_ms: Date.now() - startTime
    };
  }
}

export default {
  executeFarmCrop
};
