/**
 * Headless Survival Simulation World Engine for MIKA
 * E:\MIKA\src\evolution\world.js
 *
 * Lightweight, deterministic artificial-life survival environment
 * simulating Minecraft-like survival rules without any network or Minecraft dependency.
 */

/**
 * Seeded pseudo-random number generator using Mulberry32.
 * Produces deterministic 32-bit floating point numbers in [0, 1) and helper utilities.
 */
export class SeededRandom {
  /**
   * @param {number} [seed=12345] - Initial 32-bit integer seed
   */
  constructor(seed = 12345) {
    this.seed = (seed >>> 0) || 1;
  }

  /**
   * Generates next float in [0, 1)
   * @returns {number}
   */
  next() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generates next float in [0, 1) (alias for next)
   * @returns {number}
   */
  nextFloat() {
    return this.next();
  }

  /**
   * Float in [min, max)
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /**
   * Integer in [min, max] inclusive
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    return Math.floor(this.float(min, max + 1));
  }

  /**
   * Integer in [min, max] inclusive (alias for int)
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  nextInt(min, max) {
    return this.int(min, max);
  }

  /**
   * Boolean with probability p
   * @param {number} [p=0.5]
   * @returns {boolean}
   */
  bool(p = 0.5) {
    return this.next() < p;
  }

  /**
   * Picks random element from array
   * @template T
   * @param {T[]} array
   * @returns {T}
   */
  choice(array) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(this.next() * array.length)];
  }

  /**
   * Weighted choice based on item weights
   * @template T
   * @param {T[]} items
   * @param {number[]} weights
   * @returns {T}
   */
  weightedChoice(items, weights) {
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let r = this.next() * totalWeight;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}

/**
 * World Configuration defaults and class
 */
export class WorldConfig {
  /**
   * @param {Partial<WorldConfig>} [overrides={}]
   */
  constructor(overrides = {}) {
    this.gridSize = 64;
    this.maxTicks = 2400;
    this.ticksPerDay = 1200;
    this.resourceDensity = 0.15;
    this.threatDensity = 0.03;
    this.hungerRate = 0.005;
    this.healthRegenRate = 0.01;
    this.maxHealth = 20;
    this.maxFood = 20;
    this.threatDamage = [2, 6];
    this.shelterProtection = 0.8;
    this.timeStep = 1;

    Object.assign(this, overrides);
  }
}

/**
 * Resource types and their properties
 */
export const RESOURCES = Object.freeze({
  WOOD: { name: 'WOOD', gatherTime: 2, weight: 35, value: 1 },
  STONE: { name: 'STONE', gatherTime: 3, weight: 30, value: 2 },
  FOOD: { name: 'FOOD', gatherTime: 1, weight: 20, value: 3 },
  COAL: { name: 'COAL', gatherTime: 3, weight: 10, value: 2 },
  IRON: { name: 'IRON', gatherTime: 4, weight: 5, value: 5 }
});

/**
 * Crafting recipes
 */
export const RECIPES = Object.freeze({
  wooden_pickaxe: {
    name: 'wooden_pickaxe',
    type: 'tool',
    cost: { WOOD: 3 },
    effect: 'speeds stone mining by 2x',
    value: 4
  },
  stone_pickaxe: {
    name: 'stone_pickaxe',
    type: 'tool',
    cost: { STONE: 3, WOOD: 2 },
    effect: 'speeds stone/iron mining by 3x',
    value: 8
  },
  wooden_sword: {
    name: 'wooden_sword',
    type: 'tool',
    cost: { WOOD: 2 },
    effect: 'reduces threat damage taken by 30%',
    value: 3
  },
  stone_sword: {
    name: 'stone_sword',
    type: 'tool',
    cost: { STONE: 2, WOOD: 1 },
    effect: 'reduces threat damage taken by 50%',
    value: 6
  },
  shelter_kit: {
    name: 'shelter_kit',
    type: 'item',
    cost: { WOOD: 5, STONE: 3 },
    effect: 'can place shelter at current position',
    value: 12
  },
  cooked_food: {
    name: 'cooked_food',
    type: 'food',
    cost: { FOOD: 1, WOOD: 1 },
    effect: 'restores 6 food instead of 3 raw',
    value: 5
  }
});

/**
 * Available simulation actions
 */
export const ACTIONS = Object.freeze({
  MOVE_NORTH: 'MOVE_NORTH',
  MOVE_SOUTH: 'MOVE_SOUTH',
  MOVE_EAST: 'MOVE_EAST',
  MOVE_WEST: 'MOVE_WEST',
  GATHER: 'GATHER',
  EAT_RAW: 'EAT_RAW',
  EAT_COOKED: 'EAT_COOKED',
  CRAFT: 'CRAFT',
  BUILD_SHELTER: 'BUILD_SHELTER',
  GOTO_SHELTER: 'GOTO_SHELTER',
  FLEE: 'FLEE',
  ATTACK: 'ATTACK',
  IDLE: 'IDLE'
});

/**
 * Main Deterministic Headless Simulation World
 */
export class SimWorld {
  /**
   * @param {Partial<WorldConfig>|WorldConfig} [config={}]
   * @param {number} [seed=12345]
   */
  constructor(config = {}, seed = 12345) {
    this.config = config instanceof WorldConfig ? config : new WorldConfig(config);
    this.initialSeed = seed;
    this.reset(seed);
  }

  /**
   * Resets the world state for a new episode
   * @param {number} [seed]
   */
  reset(seed = this.initialSeed) {
    this.rng = new SeededRandom(seed);
    this.currentTick = 0;

    // Build 2D grid
    const size = this.config.gridSize;
    this.grid = new Array(size);

    const resourceTypes = Object.values(RESOURCES);
    const resourceWeights = resourceTypes.map((r) => r.weight);

    for (let y = 0; y < size; y++) {
      this.grid[y] = new Array(size);
      for (let x = 0; x < size; x++) {
        let resource = null;
        let threat = null;

        // Place resource
        if (this.rng.next() < this.config.resourceDensity) {
          const resType = this.rng.weightedChoice(resourceTypes, resourceWeights);
          resource = {
            type: resType.name,
            amount: 1,
            maxAmount: 1,
            gatherProgress: 0
          };
        }

        // Place threat (only if no resource to keep cells clean, or small independent chance)
        if (!resource && this.rng.next() < this.config.threatDensity) {
          threat = {
            active: true,
            damage: this.rng.int(this.config.threatDamage[0], this.config.threatDamage[1])
          };
        }

        this.grid[y][x] = {
          x,
          y,
          resource,
          threat,
          shelter: false
        };
      }
    }

    // Agent starting state
    const startX = Math.floor(size / 2);
    const startY = Math.floor(size / 2);

    // Ensure spawn position is free of immediate threats
    if (this.grid[startY][startX].threat) {
      this.grid[startY][startX].threat = null;
    }

    this.agent = {
      position: { x: startX, y: startY },
      health: this.config.maxHealth,
      food: this.config.maxFood,
      inventory: new Map(),
      tools: new Set(),
      hasShelter: false,
      shelterPos: null,
      alive: true,
      ticksSurvived: 0,
      totalResourcesGathered: 0,
      totalCrafted: 0,
      totalFoodEaten: 0,
      totalDamageTaken: 0,
      totalThreatsAvoided: 0,
      deathCause: null
    };

    // Initialize inventory with 0 counts for common resources
    for (const res of Object.keys(RESOURCES)) {
      this.agent.inventory.set(res, 0);
    }
    this.agent.inventory.set('cooked_food', 0);
    this.agent.inventory.set('shelter_kit', 0);

    return this.getObservation();
  }

  /**
   * Safe helper to read inventory count
   * @param {string} item
   * @returns {number}
   */
  getInventoryCount(item) {
    return this.agent.inventory.get(item) || 0;
  }

  /**
   * Helper to modify inventory count
   * @param {string} item
   * @param {number} delta
   */
  modifyInventory(item, delta) {
    const current = this.getInventoryCount(item);
    const nextVal = Math.max(0, current + delta);
    this.agent.inventory.set(item, nextVal);
  }

  /**
   * Gets cell at (x, y) safely within bounds
   * @param {number} x
   * @param {number} y
   * @returns {object|null}
   */
  getCell(x, y) {
    if (x < 0 || x >= this.config.gridSize || y < 0 || y >= this.config.gridSize) {
      return null;
    }
    return this.grid[y][x];
  }

  /**
   * Finds the nearest threat within radius
   * @param {number} [radius=5]
   * @returns {{cell: object, distance: number, dx: number, dy: number}|null}
   */
  findNearestThreat(radius = 5) {
    const { x: ax, y: ay } = this.agent.position;
    let nearest = null;
    let minDistance = Infinity;

    const minX = Math.max(0, ax - radius);
    const maxX = Math.min(this.config.gridSize - 1, ax + radius);
    const minY = Math.max(0, ay - radius);
    const maxY = Math.min(this.config.gridSize - 1, ay + radius);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cell = this.grid[y][x];
        if (cell.threat && cell.threat.active) {
          const dist = Math.abs(x - ax) + Math.abs(y - ay);
          if (dist < minDistance) {
            minDistance = dist;
            nearest = { cell, distance: dist, dx: x - ax, dy: y - ay };
          }
        }
      }
    }
    return nearest;
  }

  /**
   * Calculate mining multiplier for a given resource
   * @param {string} resourceName
   * @returns {number}
   */
  getGatherMultiplier(resourceName) {
    if (resourceName === 'STONE') {
      if (this.agent.tools.has('stone_pickaxe')) return 3;
      if (this.agent.tools.has('wooden_pickaxe')) return 2;
    } else if (resourceName === 'IRON') {
      if (this.agent.tools.has('stone_pickaxe')) return 3;
    }
    return 1;
  }

  /**
   * Advance simulation world by one tick
   * @param {string} actionId - Member of ACTIONS
   * @param {string} [craftTarget] - Recipe name if action is CRAFT
   * @returns {object} observation
   */
  tick(actionId = ACTIONS.IDLE, craftTarget = null) {
    if (!this.agent.alive) {
      return this.getObservation();
    }

    const dt = this.config.timeStep || 1;
    this.currentTick += dt;

    // 1. Hunger drain
    this.agent.food = Math.max(0, this.agent.food - (this.config.hungerRate * dt));

    // 2. Health regeneration if well-fed
    if (this.agent.food > 15 && this.agent.health < this.config.maxHealth) {
      this.agent.health = Math.min(
        this.config.maxHealth,
        this.agent.health + (this.config.healthRegenRate * dt)
      );
    }

    // 3. Execute agent action
    this._executeAction(actionId, craftTarget);

    // 4. Process day/night cycle & threat encounters
    const isNight = (this.currentTick % this.config.ticksPerDay) > (this.config.ticksPerDay / 2);
    this._processThreats(actionId, isNight);

    // 5. Check death conditions
    if (this.agent.food <= 0) {
      this.agent.alive = false;
      this.agent.deathCause = 'starvation';
    } else if (this.agent.health <= 0) {
      this.agent.alive = false;
      this.agent.health = 0;
      this.agent.deathCause = 'threat';
    }

    // 6. Record survival tick if still alive
    if (this.agent.alive) {
      this.agent.ticksSurvived += dt;
      if (this.currentTick >= this.config.maxTicks) {
        // Episode naturally completed
      }
    }

    return this.getObservation();
  }

  /**
   * Executes the chosen action
   * @private
   */
  _executeAction(actionId, craftTarget) {
    const { x, y } = this.agent.position;
    const maxBound = this.config.gridSize - 1;

    switch (actionId) {
      case ACTIONS.MOVE_NORTH:
        if (y > 0) this.agent.position.y -= 1;
        break;

      case ACTIONS.MOVE_SOUTH:
        if (y < maxBound) this.agent.position.y += 1;
        break;

      case ACTIONS.MOVE_WEST:
        if (x > 0) this.agent.position.x -= 1;
        break;

      case ACTIONS.MOVE_EAST:
        if (x < maxBound) this.agent.position.x += 1;
        break;

      case ACTIONS.GATHER: {
        const cell = this.getCell(x, y);
        if (cell && cell.resource && cell.resource.amount > 0) {
          const resConfig = RESOURCES[cell.resource.type];
          const speedMultiplier = this.getGatherMultiplier(cell.resource.type);
          const requiredTicks = Math.max(1, Math.ceil(resConfig.gatherTime / speedMultiplier));

          cell.resource.gatherProgress = (cell.resource.gatherProgress || 0) + 1;

          if (cell.resource.gatherProgress >= requiredTicks) {
            this.modifyInventory(cell.resource.type, 1);
            this.agent.totalResourcesGathered += 1;
            cell.resource.amount -= 1;
            cell.resource.gatherProgress = 0;
            if (cell.resource.amount <= 0) {
              cell.resource = null;
            }
          }
        }
        break;
      }

      case ACTIONS.EAT_RAW: {
        if (this.getInventoryCount('FOOD') > 0) {
          this.modifyInventory('FOOD', -1);
          this.agent.food = Math.min(this.config.maxFood, this.agent.food + 3);
          this.agent.totalFoodEaten += 1;
        }
        break;
      }

      case ACTIONS.EAT_COOKED: {
        if (this.getInventoryCount('cooked_food') > 0) {
          this.modifyInventory('cooked_food', -1);
          this.agent.food = Math.min(this.config.maxFood, this.agent.food + 6);
          this.agent.totalFoodEaten += 1;
        }
        break;
      }

      case ACTIONS.CRAFT: {
        if (craftTarget && RECIPES[craftTarget]) {
          const recipe = RECIPES[craftTarget];
          // Check ingredients
          let canCraft = true;
          for (const [res, count] of Object.entries(recipe.cost)) {
            if (this.getInventoryCount(res) < count) {
              canCraft = false;
              break;
            }
          }

          if (canCraft) {
            for (const [res, count] of Object.entries(recipe.cost)) {
              this.modifyInventory(res, -count);
            }
            if (recipe.type === 'tool') {
              this.agent.tools.add(recipe.name);
            } else {
              this.modifyInventory(recipe.name, 1);
            }
            this.agent.totalCrafted += 1;
          }
        }
        break;
      }

      case ACTIONS.BUILD_SHELTER: {
        if (this.getInventoryCount('shelter_kit') > 0) {
          this.modifyInventory('shelter_kit', -1);
          const cell = this.getCell(x, y);
          if (cell) {
            cell.shelter = true;
          }
          this.agent.hasShelter = true;
          this.agent.shelterPos = { x, y };
        }
        break;
      }

      case ACTIONS.GOTO_SHELTER: {
        if (this.agent.hasShelter && this.agent.shelterPos) {
          const sx = this.agent.shelterPos.x;
          const sy = this.agent.shelterPos.y;
          if (x < sx) this.agent.position.x += 1;
          else if (x > sx) this.agent.position.x -= 1;
          else if (y < sy) this.agent.position.y += 1;
          else if (y > sy) this.agent.position.y -= 1;
        }
        break;
      }

      case ACTIONS.FLEE: {
        const nearest = this.findNearestThreat(4);
        if (nearest) {
          // Move away from threat
          if (Math.abs(nearest.dx) >= Math.abs(nearest.dy)) {
            if (nearest.dx > 0 && x > 0) this.agent.position.x -= 1;
            else if (nearest.dx < 0 && x < maxBound) this.agent.position.x += 1;
          } else {
            if (nearest.dy > 0 && y > 0) this.agent.position.y -= 1;
            else if (nearest.dy < 0 && y < maxBound) this.agent.position.y += 1;
          }
          this.agent.totalThreatsAvoided += 1;
        }
        break;
      }

      case ACTIONS.ATTACK: {
        const cell = this.getCell(x, y);
        if (cell && cell.threat && cell.threat.active) {
          // Defeat threat at current position
          cell.threat.active = false;
          cell.threat = null;
          this.agent.totalThreatsAvoided += 1;
        } else {
          // Check adjacent cells for threat
          const nearest = this.findNearestThreat(1);
          if (nearest && nearest.cell.threat) {
            nearest.cell.threat.active = false;
            nearest.cell.threat = null;
            this.agent.totalThreatsAvoided += 1;
          }
        }
        break;
      }

      case ACTIONS.IDLE:
      default:
        // Do nothing
        break;
    }
  }

  /**
   * Process threats in environment and apply combat damage
   * @private
   */
  _processThreats(actionId, isNight) {
    const { x, y } = this.agent.position;
    const currentCell = this.getCell(x, y);

    // Spawning dynamic threat: threats are 3x more likely at night
    const threatChance = this.config.threatDensity * (isNight ? 3 : 1) * 0.2;
    if (this.rng.next() < threatChance && currentCell && !currentCell.threat && !currentCell.shelter) {
      currentCell.threat = {
        active: true,
        damage: this.rng.int(this.config.threatDamage[0], this.config.threatDamage[1])
      };
    }

    // Check if agent is currently on a cell with an active threat
    if (currentCell && currentCell.threat && currentCell.threat.active) {
      if (actionId === ACTIONS.ATTACK) {
        // Threat was neutralized during action execution
        return;
      }
      if (actionId === ACTIONS.FLEE) {
        // Fled away, avoids full impact
        return;
      }

      let damage = currentCell.threat.damage;

      // Shelter protection reduction
      const inShelter = currentCell.shelter || (
        this.agent.shelterPos &&
        this.agent.shelterPos.x === x &&
        this.agent.shelterPos.y === y
      );

      if (inShelter) {
        damage *= (1 - this.config.shelterProtection);
      }

      // Weapon protection reduction
      if (this.agent.tools.has('stone_sword')) {
        damage *= 0.5; // 50% damage reduction
      } else if (this.agent.tools.has('wooden_sword')) {
        damage *= 0.7; // 30% damage reduction
      }

      if (damage > 0) {
        this.agent.health -= damage;
        this.agent.totalDamageTaken += damage;
      }
    }
  }

  /**
   * Get the agent's observable state
   * @returns {object}
   */
  getObservation() {
    const { x, y } = this.agent.position;
    const currentCell = this.getCell(x, y);

    const nearbyResources = [];
    const nearbyThreats = [];
    const radius = 3;

    const minX = Math.max(0, x - radius);
    const maxX = Math.min(this.config.gridSize - 1, x + radius);
    const minY = Math.max(0, y - radius);
    const maxY = Math.min(this.config.gridSize - 1, y + radius);

    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this.grid[cy][cx];
        const dist = Math.abs(cx - x) + Math.abs(cy - y);
        if (cell.resource && cell.resource.amount > 0) {
          nearbyResources.push({
            x: cx,
            y: cy,
            dx: cx - x,
            dy: cy - y,
            distance: dist,
            type: cell.resource.type,
            amount: cell.resource.amount
          });
        }
        if (cell.threat && cell.threat.active) {
          nearbyThreats.push({
            x: cx,
            y: cy,
            dx: cx - x,
            dy: cy - y,
            distance: dist,
            damage: cell.threat.damage
          });
        }
      }
    }

    let shelterDistance = -1;
    if (this.agent.hasShelter && this.agent.shelterPos) {
      shelterDistance =
        Math.abs(this.agent.shelterPos.x - x) + Math.abs(this.agent.shelterPos.y - y);
    }

    const isNight = (this.currentTick % this.config.ticksPerDay) > (this.config.ticksPerDay / 2);
    const dayNumber = Math.floor(this.currentTick / this.config.ticksPerDay);

    return {
      agent: {
        position: { ...this.agent.position },
        health: this.agent.health,
        food: this.agent.food,
        alive: this.agent.alive
      },
      inventory: Object.fromEntries(this.agent.inventory),
      tools: Array.from(this.agent.tools),
      currentCell: {
        resource: currentCell?.resource ? { ...currentCell.resource } : null,
        threat: currentCell?.threat ? { ...currentCell.threat } : null,
        shelter: !!currentCell?.shelter
      },
      nearbyResources,
      nearbyThreats,
      hasShelter: this.agent.hasShelter,
      shelterDistance,
      isNight,
      tick: this.currentTick,
      dayNumber
    };
  }

  /**
   * Calculates weighted inventory value
   * @returns {number}
   */
  calculateInventoryValue() {
    let total = 0;
    for (const [item, count] of this.agent.inventory.entries()) {
      if (count <= 0) continue;
      if (RESOURCES[item]) {
        total += count * RESOURCES[item].value;
      } else if (RECIPES[item]) {
        total += count * RECIPES[item].value;
      }
    }
    for (const tool of this.agent.tools) {
      if (RECIPES[tool]) {
        total += RECIPES[tool].value;
      }
    }
    return total;
  }

  /**
   * Returns survival metrics for scoring
   * @returns {object}
   */
  getMetrics() {
    return {
      ticksSurvived: this.agent.ticksSurvived,
      totalResourcesGathered: this.agent.totalResourcesGathered,
      totalCrafted: this.agent.totalCrafted,
      totalFoodEaten: this.agent.totalFoodEaten,
      totalDamageTaken: this.agent.totalDamageTaken,
      totalThreatsAvoided: this.agent.totalThreatsAvoided,
      deathCause: this.agent.deathCause,
      alive: this.agent.alive,
      inventoryValue: this.calculateInventoryValue(),
      toolCount: this.agent.tools.size,
      builtShelter: this.agent.hasShelter
    };
  }
}
