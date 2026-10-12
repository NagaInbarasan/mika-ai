import { Vec3 } from 'vec3';

/**
 * Places a block from inventory to construct shelter or defensive barriers.
 * @param {import('mineflayer').Bot} bot
 * @param {Object} args
 * @param {string} [args.block='dirt'] - Name of block to place (e.g. dirt, sand, cobblestone, oak_planks)
 * @param {number} [args.dx=1] - Relative X offset
 * @param {number} [args.dy=0] - Relative Y offset
 * @param {number} [args.dz=0] - Relative Z offset
 * @returns {Promise<Object>} Execution result
 */
export async function executePlaceBlock(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const blockName = args.block || args.item || 'dirt';

  // 1. Check if block is in inventory
  if (!bot.inventory) {
    return { status: 'failed', error_code: 'NO_INVENTORY', error: 'Inventory not available' };
  }

  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  const itemToPlace = items.find(i => i.name === blockName || (blockName && i.name.includes(blockName)));

  if (!itemToPlace) {
    return {
      status: 'failed',
      error_code: 'ITEM_NOT_IN_INVENTORY',
      error: `Block '${blockName}' is not in inventory to place`
    };
  }

  const startTime = Date.now();

  try {
    // 2. Select target location and reference block
    const botPos = bot.entity.position;
    const dx = args.dx !== undefined ? args.dx : 1;
    const dy = args.dy !== undefined ? args.dy : 0;
    const dz = args.dz !== undefined ? args.dz : 0;

    const targetPos = botPos.offset ? botPos.offset(dx, dy, dz) : { x: botPos.x + dx, y: botPos.y + dy, z: botPos.z + dz };
    
    // Find reference block below or adjacent to target position
    let refBlock = null;
    if (typeof bot.blockAt === 'function') {
      const belowPos = targetPos.offset ? targetPos.offset(0, -1, 0) : { x: targetPos.x, y: targetPos.y - 1, z: targetPos.z };
      refBlock = bot.blockAt(belowPos) || bot.blockAt(botPos.offset ? botPos.offset(0, -1, 0) : { x: botPos.x, y: botPos.y - 1, z: botPos.z });
    }

    // 3. Equip item
    if (typeof bot.equip === 'function') {
      await bot.equip(itemToPlace, 'hand');
    }

    // 4. Place block against reference
    if (typeof bot.placeBlock === 'function' && refBlock) {
      await bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 });
    }

    const duration = Date.now() - startTime;
    return {
      status: 'success',
      duration_ms: duration,
      data: {
        placed_block: itemToPlace.name,
        target_position: {
          x: Math.floor(targetPos.x),
          y: Math.floor(targetPos.y),
          z: Math.floor(targetPos.z)
        }
      }
    };
  } catch (err) {
    return {
      status: 'failed',
      error_code: 'PLACE_BLOCK_ERROR',
      error: err.message,
      duration_ms: Date.now() - startTime
    };
  }
}

export default executePlaceBlock;
