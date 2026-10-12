/**
 * MIKA V1.3 - Storage and Categorized Chest Organization System
 * 
 * - Classifies Minecraft items into 7 logical storage categories
 * - Enforces minimum personal inventory reserves before depositing
 * - Tracks chest capacity and handles full chests (overflow detection)
 * - Deposits surplus items into designated chests
 */

export const STORAGE_CATEGORIES = Object.freeze({
  BUILDING: 'BUILDING',
  FOOD: 'FOOD',
  TOOLS: 'TOOLS',
  WEAPONS_ARMOR: 'WEAPONS_ARMOR',
  RESOURCES: 'RESOURCES',
  VALUABLES: 'VALUABLES',
  MISC: 'MISC'
});

export const DEFAULT_PERSONAL_RESERVES = {
  pickaxe: 1,
  sword: 1,
  axe: 1,
  torch: 8,
  building_blocks: 16,
  food: 8
};

export class StorageOrganizer {
  constructor(options = {}) {
    this.personalReserves = { ...DEFAULT_PERSONAL_RESERVES, ...(options.personalReserves || {}) };
    this.chestSlotsMax = options.chestSlotsMax || 27; // Single chest capacity
  }

  /**
   * Categorizes an item name into one of the 7 storage categories.
   * 
   * @param {string} itemName
   * @returns {string} One of STORAGE_CATEGORIES
   */
  categorizeItem(itemName) {
    if (!itemName) return STORAGE_CATEGORIES.MISC;
    const name = itemName.toLowerCase();

    // 1. Weapons & Armor
    if (name.includes('sword') || name.includes('shield') || name.includes('bow') || name.includes('arrow') ||
        name.includes('helmet') || name.includes('chestplate') || name.includes('leggings') || name.includes('boots')) {
      return STORAGE_CATEGORIES.WEAPONS_ARMOR;
    }

    // 2. Tools
    if (name.includes('pickaxe') || name.includes('axe') || name.includes('shovel') || name.includes('hoe') || name.includes('shears')) {
      return STORAGE_CATEGORIES.TOOLS;
    }

    // 3. Valuables
    if (name.includes('diamond') || name.includes('gold') || name.includes('emerald') || name.includes('netherite') || name.includes('enchanted')) {
      return STORAGE_CATEGORIES.VALUABLES;
    }

    // 4. Food
    if (name.includes('beef') || name.includes('pork') || name.includes('mutton') || name.includes('chicken') ||
        name.includes('bread') || name.includes('apple') || name.includes('carrot') || name.includes('potato') ||
        name.includes('fish') || name.includes('cod') || name.includes('salmon') || name.includes('berry') || name.includes('seed') || name.includes('wheat')) {
      return STORAGE_CATEGORIES.FOOD;
    }

    // 5. Resources / Crafting
    if (name.includes('iron') || name.includes('copper') || name.includes('coal') || name.includes('charcoal') ||
        name.includes('stick') || name.includes('flint') || name.includes('string') || name.includes('leather') || name.includes('feather')) {
      return STORAGE_CATEGORIES.RESOURCES;
    }

    // 6. Building Materials
    if (name.includes('dirt') || name.includes('stone') || name.includes('cobble') || name.includes('plank') ||
        name.includes('log') || name.includes('wood') || name.includes('sand') || name.includes('gravel') || name.includes('brick') || name.includes('deepslate')) {
      return STORAGE_CATEGORIES.BUILDING;
    }

    return STORAGE_CATEGORIES.MISC;
  }

  /**
   * Computes which items in bot inventory are surplus and eligible for chest deposit,
   * while preserving minimum personal survival equipment.
   * 
   * @param {Array<{ name: string, count: number }>} inventoryItems
   * @returns {Array<{ item: string, count: number, category: string }>}
   */
  calculateDepositableSurplus(inventoryItems = []) {
    const depositable = [];
    let keptFood = 0;
    let keptBuilding = 0;
    let keptPickaxes = 0;
    let keptSwords = 0;
    let keptAxes = 0;
    let keptTorches = 0;

    for (const item of inventoryItems) {
      const category = this.categorizeItem(item.name);
      let count = item.count || 1;

      // Retain reserves
      if (category === STORAGE_CATEGORIES.FOOD) {
        if (keptFood < this.personalReserves.food) {
          const needed = this.personalReserves.food - keptFood;
          const keep = Math.min(count, needed);
          keptFood += keep;
          count -= keep;
        }
      } else if (category === STORAGE_CATEGORIES.BUILDING) {
        if (keptBuilding < this.personalReserves.building_blocks) {
          const needed = this.personalReserves.building_blocks - keptBuilding;
          const keep = Math.min(count, needed);
          keptBuilding += keep;
          count -= keep;
        }
      } else if (item.name.includes('pickaxe')) {
        if (keptPickaxes < this.personalReserves.pickaxe) {
          keptPickaxes++;
          count--;
        }
      } else if (item.name.includes('sword')) {
        if (keptSwords < this.personalReserves.sword) {
          keptSwords++;
          count--;
        }
      } else if (item.name.includes('axe')) {
        if (keptAxes < this.personalReserves.axe) {
          keptAxes++;
          count--;
        }
      } else if (item.name === 'torch') {
        if (keptTorches < this.personalReserves.torch) {
          const needed = this.personalReserves.torch - keptTorches;
          const keep = Math.min(count, needed);
          keptTorches += keep;
          count -= keep;
        }
      }

      if (count > 0) {
        depositable.push({
          item: item.name,
          count,
          category
        });
      }
    }

    return depositable;
  }

  /**
   * Simulates or executes depositing surplus items into a chest container.
   * Tracks container occupancy and detects full chest condition.
   * 
   * @param {import('mineflayer').Bot} bot
   * @param {Object} chestContainer - Mineflayer chest or mock container
   * @param {Array} surplusItems
   * @returns {Promise<Object>} Deposit result with verified counts
   */
  async depositSurplusIntoChest(bot, chestContainer, surplusItems) {
    if (!chestContainer) {
      return { status: 'failed', error: 'No chest container provided' };
    }

    const deposited = [];
    let isFull = false;
    const currentOccupiedSlots = chestContainer.occupiedSlots || 0;

    for (const entry of surplusItems) {
      if ((currentOccupiedSlots + deposited.length) >= this.chestSlotsMax) {
        isFull = true;
        break;
      }

      if (typeof chestContainer.deposit === 'function') {
        try {
          const itemType = bot?.registry?.itemsByName?.[entry.item]?.id;
          if (itemType) {
            await chestContainer.deposit(itemType, null, entry.count);
          } else {
            await chestContainer.deposit(entry.item, null, entry.count);
          }
          deposited.push(entry);
        } catch (_) {}
      } else {
        // Mock container deposit
        deposited.push(entry);
      }
    }

    return {
      status: 'success',
      depositedCount: deposited.length,
      depositedItems: deposited,
      isChestFull: isFull,
      remainingSlots: Math.max(0, this.chestSlotsMax - (currentOccupiedSlots + deposited.length))
    };
  }
}

export const defaultStorageOrganizer = new StorageOrganizer();
export default defaultStorageOrganizer;
