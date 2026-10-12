/**
 * Decision-making Policy System for Headless Artificial Life Evolution
 * E:\MIKA\src\evolution\policy.js
 *
 * Implements weight-matrix neural policies, random baseline policies,
 * heuristic baseline policies, and feature extraction from simulation observations.
 */

import { ACTIONS, RECIPES, SeededRandom } from './world.js';

/**
 * 6 Crafting targets defined in the simulation environment
 */
export const CRAFT_TARGETS = Object.freeze([
  'wooden_pickaxe',
  'stone_pickaxe',
  'wooden_sword',
  'stone_sword',
  'shelter_kit',
  'cooked_food'
]);

/**
 * Total 19 discrete actions: 13 base actions + 6 craft targets
 */
export const ACTION_DEFINITIONS = Object.freeze([
  { actionName: ACTIONS.MOVE_NORTH, craftTarget: null },     // 0
  { actionName: ACTIONS.MOVE_SOUTH, craftTarget: null },     // 1
  { actionName: ACTIONS.MOVE_EAST, craftTarget: null },      // 2
  { actionName: ACTIONS.MOVE_WEST, craftTarget: null },      // 3
  { actionName: ACTIONS.GATHER, craftTarget: null },         // 4
  { actionName: ACTIONS.EAT_RAW, craftTarget: null },        // 5
  { actionName: ACTIONS.EAT_COOKED, craftTarget: null },     // 6
  { actionName: ACTIONS.CRAFT, craftTarget: null },          // 7 (generic craft)
  { actionName: ACTIONS.BUILD_SHELTER, craftTarget: null },  // 8
  { actionName: ACTIONS.GOTO_SHELTER, craftTarget: null },   // 9
  { actionName: ACTIONS.FLEE, craftTarget: null },           // 10
  { actionName: ACTIONS.ATTACK, craftTarget: null },         // 11
  { actionName: ACTIONS.IDLE, craftTarget: null },           // 12
  { actionName: ACTIONS.CRAFT, craftTarget: 'wooden_pickaxe' }, // 13
  { actionName: ACTIONS.CRAFT, craftTarget: 'stone_pickaxe' },  // 14
  { actionName: ACTIONS.CRAFT, craftTarget: 'wooden_sword' },    // 15
  { actionName: ACTIONS.CRAFT, craftTarget: 'stone_sword' },     // 16
  { actionName: ACTIONS.CRAFT, craftTarget: 'shelter_kit' },     // 17
  { actionName: ACTIONS.CRAFT, craftTarget: 'cooked_food' }      // 18
]);

/**
 * Helper to look up an action definition index
 * @param {string} actionName
 * @param {string|null} [craftTarget=null]
 * @returns {number}
 */
export function getActionIndex(actionName, craftTarget = null) {
  if (actionName === ACTIONS.CRAFT && craftTarget) {
    const idx = ACTION_DEFINITIONS.findIndex(
      (def) => def.actionName === ACTIONS.CRAFT && def.craftTarget === craftTarget
    );
    if (idx !== -1) return idx;
  }
  const idx = ACTION_DEFINITIONS.findIndex(
    (def) => def.actionName === actionName && (def.craftTarget === null || !craftTarget)
  );
  return idx !== -1 ? idx : 0;
}

/**
 * Box-Muller transform for standard Gaussian random noise (mean 0, std 1)
 * @param {SeededRandom|null} [rng=null]
 * @returns {number}
 */
function gaussianRandom(rng = null) {
  const u1 = Math.max(1e-15, rng ? rng.next() : Math.random());
  const u2 = rng ? rng.next() : Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Generates unique policy ID
 * @returns {string}
 */
function generateId() {
  return `policy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extracts a fixed-length Float64Array feature vector (19 elements) from world observation.
 *
 * Vector layout:
 * [0]  health / maxHealth (normalized 0-1)
 * [1]  food / maxFood (normalized 0-1)
 * [2]  isNight (0 or 1)
 * [3]  nearbyResourceCount (capped at 10, /10)
 * [4]  nearbyThreatCount (capped at 5, /5)
 * [5]  hasWoodInInventory (0 or 1)
 * [6]  hasStoneInInventory (0 or 1)
 * [7]  hasFoodInInventory (0 or 1)
 * [8]  hasIronInInventory (0 or 1)
 * [9]  currentCellHasResource (0 or 1)
 * [10] currentCellHasThreat (0 or 1)
 * [11] hasShelter (0 or 1)
 * [12] shelterDistance (normalized, /gridSize)
 * [13] hasPickaxe (0 or 1)
 * [14] hasSword (0 or 1)
 * [15] canCraftAnything (0 or 1)
 * [16] foodUrgency: 1 - (food/maxFood) clamped 0-1
 * [17] healthUrgency: 1 - (health/maxHealth) clamped 0-1
 * [18] tickProgress: tick / maxTicks (normalized 0-1)
 *
 * @param {object} observation - Observation object from SimWorld
 * @returns {Float64Array}
 */
export function extractFeatures(observation = {}) {
  const maxHealth = observation.maxHealth ?? observation.config?.maxHealth ?? 20;
  const maxFood = observation.maxFood ?? observation.config?.maxFood ?? 20;
  const gridSize = observation.gridSize ?? observation.config?.gridSize ?? 64;
  const maxTicks = observation.maxTicks ?? observation.config?.maxTicks ?? 2400;

  const agent = observation.agent || {};
  const currentCell = observation.currentCell || {};
  const inv = observation.inventory || {};

  const getInvCount = (item) => {
    if (typeof inv.get === 'function') {
      return inv.get(item) ?? inv.get(item.toLowerCase()) ?? 0;
    }
    return inv[item] ?? inv[item.toLowerCase()] ?? 0;
  };

  const tools = observation.tools instanceof Set
    ? observation.tools
    : new Set(observation.tools || []);

  const health = agent.health ?? maxHealth;
  const food = agent.food ?? maxFood;
  const healthNorm = Math.max(0, Math.min(1, health / maxHealth));
  const foodNorm = Math.max(0, Math.min(1, food / maxFood));

  const isNight = observation.isNight ? 1 : 0;

  const nearbyResCount = Array.isArray(observation.nearbyResources)
    ? observation.nearbyResources.length
    : 0;
  const nearbyThreatCount = Array.isArray(observation.nearbyThreats)
    ? observation.nearbyThreats.length
    : 0;

  const resCountNorm = Math.min(10, nearbyResCount) / 10;
  const threatCountNorm = Math.min(5, nearbyThreatCount) / 5;

  const hasWood = getInvCount('WOOD') > 0 ? 1 : 0;
  const hasStone = getInvCount('STONE') > 0 ? 1 : 0;
  const hasFood = (getInvCount('FOOD') > 0 || getInvCount('cooked_food') > 0) ? 1 : 0;
  const hasIron = getInvCount('IRON') > 0 ? 1 : 0;

  const currentCellHasResource = (currentCell.resource && currentCell.resource.amount > 0) ? 1 : 0;
  const currentCellHasThreat = (currentCell.threat && currentCell.threat.active !== false) ? 1 : 0;

  const hasShelter = (observation.hasShelter || currentCell.shelter) ? 1 : 0;

  let shelterDistNorm = 0;
  if (observation.shelterDistance != null && observation.shelterDistance >= 0) {
    shelterDistNorm = Math.min(1, Math.max(0, observation.shelterDistance / gridSize));
  } else if (!hasShelter && (observation.shelterDistance == null || observation.shelterDistance < 0)) {
    // No shelter exists or out of range
    shelterDistNorm = 0;
  }

  const hasPickaxe = (tools.has('wooden_pickaxe') || tools.has('stone_pickaxe')) ? 1 : 0;
  const hasSword = (tools.has('wooden_sword') || tools.has('stone_sword')) ? 1 : 0;

  // Check if at least one recipe can be crafted
  let canCraftAnything = 0;
  for (const recipe of Object.values(RECIPES)) {
    let canCraft = true;
    for (const [res, cost] of Object.entries(recipe.cost)) {
      if (getInvCount(res) < cost) {
        canCraft = false;
        break;
      }
    }
    if (canCraft) {
      canCraftAnything = 1;
      break;
    }
  }

  const foodUrgency = Math.max(0, Math.min(1, 1 - foodNorm));
  const healthUrgency = Math.max(0, Math.min(1, 1 - healthNorm));

  const tick = observation.tick ?? 0;
  const tickProgress = Math.max(0, Math.min(1, tick / maxTicks));

  const features = new Float64Array(19);
  features[0] = healthNorm;
  features[1] = foodNorm;
  features[2] = isNight;
  features[3] = resCountNorm;
  features[4] = threatCountNorm;
  features[5] = hasWood;
  features[6] = hasStone;
  features[7] = hasFood;
  features[8] = hasIron;
  features[9] = currentCellHasResource;
  features[10] = currentCellHasThreat;
  features[11] = hasShelter;
  features[12] = shelterDistNorm;
  features[13] = hasPickaxe;
  features[14] = hasSword;
  features[15] = canCraftAnything;
  features[16] = foodUrgency;
  features[17] = healthUrgency;
  features[18] = tickProgress;

  return features;
}

/**
 * Evolvable linear neural policy mapping feature vectors to action distributions.
 */
export class Policy {
  /**
   * @param {object} [options={}]
   * @param {number} [options.numFeatures=19]
   * @param {number} [options.numActions=19]
   * @param {Float64Array|number[]} [options.weights]
   * @param {Float64Array|number[]} [options.biases]
   * @param {string} [options.id]
   * @param {number} [options.generation=0]
   * @param {string|null} [options.parentId=null]
   * @param {number} [options.fitness=0]
   * @param {object} [options.metadata={}]
   */
  constructor(options = {}) {
    this.numFeatures = options.numFeatures ?? 19;
    this.numActions = options.numActions ?? 19;
    this.id = options.id || generateId();
    this.generation = options.generation ?? 0;
    this.parentId = options.parentId ?? null;
    this.fitness = options.fitness ?? 0;
    this.metadata = options.metadata ? { ...options.metadata } : {};

    const weightSize = this.numFeatures * this.numActions;
    if (options.weights) {
      this.weights = options.weights instanceof Float64Array
        ? options.weights
        : new Float64Array(options.weights);
    } else {
      this.weights = new Float64Array(weightSize);
      const scale = Math.sqrt(2 / this.numFeatures);
      for (let i = 0; i < weightSize; i++) {
        this.weights[i] = gaussianRandom() * scale;
      }
    }

    if (options.biases) {
      this.biases = options.biases instanceof Float64Array
        ? options.biases
        : new Float64Array(options.biases);
    } else {
      this.biases = new Float64Array(this.numActions);
    }
  }

  /**
   * Computes action probabilities and selects an action
   * @param {Float64Array|number[]} features
   * @param {object} [options={}]
   * @param {boolean} [options.greedy=true] - If true, picks highest score; if false, samples
   * @param {number} [options.temperature=1.0] - Softmax temperature scaling
   * @param {SeededRandom|null} [options.rng=null]
   * @returns {{actionIndex: number, actionName: string, craftTarget: string|null, confidence: number}}
   */
  selectAction(features, options = {}) {
    const { greedy = true, temperature = 1.0, rng = null } = options;
    const scores = new Float64Array(this.numActions);

    for (let a = 0; a < this.numActions; a++) {
      let sum = this.biases[a];
      for (let f = 0; f < this.numFeatures; f++) {
        sum += features[f] * this.weights[f * this.numActions + a];
      }
      scores[a] = sum;
    }

    // Softmax with numerical stability
    let maxScore = -Infinity;
    for (let a = 0; a < this.numActions; a++) {
      if (scores[a] > maxScore) maxScore = scores[a];
    }

    const temp = Math.max(1e-5, temperature);
    const expScores = new Float64Array(this.numActions);
    let sumExp = 0;

    for (let a = 0; a < this.numActions; a++) {
      const exp = Math.exp((scores[a] - maxScore) / temp);
      expScores[a] = exp;
      sumExp += exp;
    }

    const probs = new Float64Array(this.numActions);
    for (let a = 0; a < this.numActions; a++) {
      probs[a] = expScores[a] / sumExp;
    }

    let actionIndex = 0;
    if (greedy) {
      let bestProb = -Infinity;
      for (let a = 0; a < this.numActions; a++) {
        if (probs[a] > bestProb) {
          bestProb = probs[a];
          actionIndex = a;
        }
      }
    } else {
      // Proportional sampling
      let r = rng ? rng.next() : Math.random();
      for (let a = 0; a < this.numActions; a++) {
        r -= probs[a];
        if (r <= 0) {
          actionIndex = a;
          break;
        }
      }
    }

    const def = ACTION_DEFINITIONS[actionIndex] || {
      actionName: ACTIONS.IDLE,
      craftTarget: null
    };

    return {
      actionIndex,
      actionName: def.actionName,
      craftTarget: def.craftTarget,
      confidence: probs[actionIndex]
    };
  }

  /**
   * Mutates policy weights and biases with Gaussian perturbations
   * @param {number} [mutationRate=0.1]
   * @param {number} [mutationStrength=0.3]
   * @param {SeededRandom|null} [rng=null]
   * @returns {Policy}
   */
  mutate(mutationRate = 0.1, mutationStrength = 0.3, rng = null) {
    const newWeights = new Float64Array(this.weights.length);
    const newBiases = new Float64Array(this.biases.length);

    for (let i = 0; i < this.weights.length; i++) {
      let w = this.weights[i];
      const r = rng ? rng.next() : Math.random();
      if (r < mutationRate) {
        w += gaussianRandom(rng) * mutationStrength;
      }
      newWeights[i] = w;
    }

    for (let a = 0; a < this.biases.length; a++) {
      let b = this.biases[a];
      const r = rng ? rng.next() : Math.random();
      if (r < mutationRate) {
        b += gaussianRandom(rng) * mutationStrength;
      }
      newBiases[a] = b;
    }

    return new Policy({
      numFeatures: this.numFeatures,
      numActions: this.numActions,
      weights: newWeights,
      biases: newBiases,
      id: generateId(),
      generation: this.generation + 1,
      parentId: this.id,
      metadata: { ...this.metadata },
      fitness: 0
    });
  }

  /**
   * Performs uniform crossover with another policy
   * @param {Policy} otherPolicy
   * @param {SeededRandom|null} [rng=null]
   * @returns {Policy}
   */
  crossover(otherPolicy, rng = null) {
    const newWeights = new Float64Array(this.weights.length);
    const newBiases = new Float64Array(this.biases.length);

    for (let i = 0; i < this.weights.length; i++) {
      const pickThis = (rng ? rng.next() : Math.random()) < 0.5;
      newWeights[i] = pickThis ? this.weights[i] : otherPolicy.weights[i];
    }

    for (let a = 0; a < this.biases.length; a++) {
      const pickThis = (rng ? rng.next() : Math.random()) < 0.5;
      newBiases[a] = pickThis ? this.biases[a] : otherPolicy.biases[a];
    }

    return new Policy({
      numFeatures: this.numFeatures,
      numActions: this.numActions,
      weights: newWeights,
      biases: newBiases,
      id: generateId(),
      generation: Math.max(this.generation, otherPolicy.generation) + 1,
      parentId: this.id,
      metadata: { ...this.metadata, otherParentId: otherPolicy.id },
      fitness: 0
    });
  }

  /**
   * Creates an exact clone with a new unique id
   * @returns {Policy}
   */
  clone() {
    return new Policy({
      numFeatures: this.numFeatures,
      numActions: this.numActions,
      weights: new Float64Array(this.weights),
      biases: new Float64Array(this.biases),
      id: generateId(),
      generation: this.generation,
      parentId: this.parentId,
      metadata: { ...this.metadata },
      fitness: this.fitness
    });
  }

  /**
   * Serializes policy to a plain JSON-compatible object
   * @returns {object}
   */
  serialize() {
    return {
      id: this.id,
      parentId: this.parentId,
      generation: this.generation,
      fitness: this.fitness,
      numFeatures: this.numFeatures,
      numActions: this.numActions,
      weights: Array.from(this.weights),
      biases: Array.from(this.biases),
      metadata: { ...this.metadata }
    };
  }

  /**
   * Deserializes a policy from plain JSON object
   * @param {object} data
   * @returns {Policy}
   */
  static deserialize(data) {
    return new Policy({
      id: data.id,
      parentId: data.parentId ?? null,
      generation: data.generation ?? 0,
      fitness: data.fitness ?? 0,
      numFeatures: data.numFeatures ?? 19,
      numActions: data.numActions ?? 19,
      weights: new Float64Array(data.weights),
      biases: new Float64Array(data.biases),
      metadata: data.metadata ?? {}
    });
  }

  /**
   * Creates a random policy deterministically seeded with SeededRandom
   * @param {number|SeededRandom} [seed=12345]
   * @param {object} [options={}]
   * @returns {Policy}
   */
  static createRandom(seed = 12345, options = {}) {
    const rng = typeof seed === 'object' && seed !== null && typeof seed.next === 'function'
      ? seed
      : new SeededRandom(seed);

    const numFeatures = options.numFeatures ?? 19;
    const numActions = options.numActions ?? 19;
    const weights = new Float64Array(numFeatures * numActions);
    const biases = new Float64Array(numActions);

    const scale = Math.sqrt(2 / numFeatures);
    for (let i = 0; i < weights.length; i++) {
      weights[i] = gaussianRandom(rng) * scale;
    }
    for (let a = 0; a < biases.length; a++) {
      biases[a] = 0;
    }

    return new Policy({
      numFeatures,
      numActions,
      weights,
      biases,
      id: options.id || generateId(),
      generation: options.generation ?? 0,
      parentId: options.parentId ?? null,
      fitness: options.fitness ?? 0,
      metadata: options.metadata ?? {}
    });
  }
}

/**
 * Random baseline policy that picks actions uniformly at random
 */
export class RandomPolicy {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.id = options.id || `random_${Math.random().toString(36).slice(2, 8)}`;
    this.numActions = options.numActions ?? 19;
    this.generation = 0;
    this.parentId = null;
    this.fitness = 0;
    this.metadata = options.metadata ? { ...options.metadata } : {};
  }

  /**
   * Selects an action uniformly at random
   * @param {any} [_features]
   * @param {object} [options={}]
   * @param {SeededRandom|null} [options.rng=null]
   * @returns {{actionIndex: number, actionName: string, craftTarget: string|null, confidence: number}}
   */
  selectAction(_features, options = {}) {
    const rng = options.rng || null;
    const actionIndex = rng
      ? rng.int(0, this.numActions - 1)
      : Math.floor(Math.random() * this.numActions);

    const def = ACTION_DEFINITIONS[actionIndex] || {
      actionName: ACTIONS.IDLE,
      craftTarget: null
    };

    return {
      actionIndex,
      actionName: def.actionName,
      craftTarget: def.craftTarget,
      confidence: 1 / this.numActions
    };
  }

  clone() {
    return new RandomPolicy({
      numActions: this.numActions,
      metadata: { ...this.metadata }
    });
  }

  serialize() {
    return {
      type: 'RandomPolicy',
      id: this.id,
      numActions: this.numActions,
      generation: this.generation,
      fitness: this.fitness,
      metadata: { ...this.metadata }
    };
  }

  static deserialize(data) {
    const p = new RandomPolicy({
      id: data.id,
      numActions: data.numActions,
      metadata: data.metadata
    });
    p.generation = data.generation ?? 0;
    p.fitness = data.fitness ?? 0;
    return p;
  }
}

/**
 * Hand-coded rule-based heuristic baseline policy implementing sensible survival priorities:
 * 1. If health < 5 and has food → eat
 * 2. If food < 8 and has food → eat
 * 3. If nearby threat and no sword → flee
 * 4. If nearby threat and has sword → attack
 * 5. If night and has shelter → goto_shelter
 * 6. If night and no shelter and can craft shelter_kit → craft shelter_kit
 * 7. If has shelter_kit → build_shelter
 * 8. If current cell has resource → gather
 * 9. If can craft useful tool → craft it
 * 10. Otherwise → move toward nearest resource
 */
export class HeuristicPolicy {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.id = options.id || `heuristic_${Math.random().toString(36).slice(2, 8)}`;
    this.numActions = options.numActions ?? 19;
    this.generation = 0;
    this.parentId = null;
    this.fitness = 0;
    this.metadata = options.metadata ? { ...options.metadata } : {};
  }

  /**
   * Selects an action using survival heuristics.
   * Accepts either raw observation directly, or (features, { observation }) / (features, observation).
   *
   * @param {object|Float64Array} input - Observation object or feature vector
   * @param {object} [context={}] - Context containing raw observation if input is features
   * @returns {{actionIndex: number, actionName: string, craftTarget: string|null, confidence: number}}
   */
  selectAction(input, context = {}) {
    let observation = null;
    let features = null;

    if (input instanceof Float64Array || Array.isArray(input)) {
      features = input;
      observation = context.observation || (context.agent ? context : null);
    } else if (input && typeof input === 'object') {
      observation = input;
    }

    // If observation is not available, infer from feature vector
    if (!observation && features) {
      return this._selectActionFromFeatures(features);
    }

    return this._selectActionFromObservation(observation || {});
  }

  /**
   * Heuristic action selection from raw observation
   * @private
   */
  _selectActionFromObservation(obs) {
    const agent = obs.agent || {};
    const health = agent.health ?? 20;
    const food = agent.food ?? 20;
    const inv = obs.inventory || {};
    const currentCell = obs.currentCell || {};

    const getInvCount = (item) => {
      if (typeof inv.get === 'function') {
        return inv.get(item) ?? inv.get(item.toLowerCase()) ?? 0;
      }
      return inv[item] ?? inv[item.toLowerCase()] ?? 0;
    };

    const cookedFoodCount = getInvCount('cooked_food');
    const rawFoodCount = getInvCount('FOOD');
    const hasFood = cookedFoodCount > 0 || rawFoodCount > 0;

    const tools = obs.tools instanceof Set
      ? obs.tools
      : new Set(obs.tools || []);
    const hasSword = tools.has('stone_sword') || tools.has('wooden_sword');

    const nearbyThreats = Array.isArray(obs.nearbyThreats) ? obs.nearbyThreats : [];
    const hasNearbyThreat = nearbyThreats.length > 0 || !!(currentCell.threat && currentCell.threat.active !== false);

    const isNight = !!obs.isNight;
    const hasShelter = !!obs.hasShelter;
    const shelterKitCount = getInvCount('shelter_kit');

    const woodCount = getInvCount('WOOD');
    const stoneCount = getInvCount('STONE');

    // 1. If health < 5 and has food → eat
    if (health < 5 && hasFood) {
      return this._formatAction(cookedFoodCount > 0 ? ACTIONS.EAT_COOKED : ACTIONS.EAT_RAW);
    }

    // 2. If food < 8 and has food → eat
    if (food < 8 && hasFood) {
      return this._formatAction(cookedFoodCount > 0 ? ACTIONS.EAT_COOKED : ACTIONS.EAT_RAW);
    }

    // 3 & 4. Threat response
    if (hasNearbyThreat) {
      if (hasSword) {
        return this._formatAction(ACTIONS.ATTACK);
      }
      return this._formatAction(ACTIONS.FLEE);
    }

    // 5. If night and has shelter → goto_shelter
    if (isNight && hasShelter) {
      return this._formatAction(ACTIONS.GOTO_SHELTER);
    }

    // 6. If night and no shelter and can craft shelter_kit → craft shelter_kit
    if (isNight && !hasShelter && woodCount >= 5 && stoneCount >= 3) {
      return this._formatAction(ACTIONS.CRAFT, 'shelter_kit');
    }

    // 7. If has shelter_kit → build_shelter
    if (shelterKitCount > 0 && !hasShelter) {
      return this._formatAction(ACTIONS.BUILD_SHELTER);
    }

    // 8. If current cell has resource → gather
    if (currentCell.resource && currentCell.resource.amount > 0) {
      return this._formatAction(ACTIONS.GATHER);
    }

    // 9. If can craft useful tool → craft it
    if (!tools.has('stone_sword') && stoneCount >= 2 && woodCount >= 1) {
      return this._formatAction(ACTIONS.CRAFT, 'stone_sword');
    }
    if (!tools.has('stone_pickaxe') && stoneCount >= 3 && woodCount >= 2) {
      return this._formatAction(ACTIONS.CRAFT, 'stone_pickaxe');
    }
    if (!tools.has('wooden_sword') && !tools.has('stone_sword') && woodCount >= 2) {
      return this._formatAction(ACTIONS.CRAFT, 'wooden_sword');
    }
    if (!tools.has('wooden_pickaxe') && !tools.has('stone_pickaxe') && woodCount >= 3) {
      return this._formatAction(ACTIONS.CRAFT, 'wooden_pickaxe');
    }
    if (rawFoodCount >= 1 && woodCount >= 1) {
      return this._formatAction(ACTIONS.CRAFT, 'cooked_food');
    }

    // 10. Otherwise → move toward nearest resource
    const nearbyRes = Array.isArray(obs.nearbyResources) ? obs.nearbyResources : [];
    if (nearbyRes.length > 0) {
      // Find resource with minimum distance
      let nearest = nearbyRes[0];
      for (let i = 1; i < nearbyRes.length; i++) {
        if (nearbyRes[i].distance < nearest.distance) {
          nearest = nearbyRes[i];
        }
      }

      if (nearest) {
        const dx = nearest.dx;
        const dy = nearest.dy;

        if (Math.abs(dx) >= Math.abs(dy)) {
          if (dx > 0) return this._formatAction(ACTIONS.MOVE_EAST);
          if (dx < 0) return this._formatAction(ACTIONS.MOVE_WEST);
          if (dy > 0) return this._formatAction(ACTIONS.MOVE_SOUTH);
          if (dy < 0) return this._formatAction(ACTIONS.MOVE_NORTH);
        } else {
          if (dy > 0) return this._formatAction(ACTIONS.MOVE_SOUTH);
          if (dy < 0) return this._formatAction(ACTIONS.MOVE_NORTH);
          if (dx > 0) return this._formatAction(ACTIONS.MOVE_EAST);
          if (dx < 0) return this._formatAction(ACTIONS.MOVE_WEST);
        }
      }
    }

    // Fallback if no nearby resources found
    return this._formatAction(ACTIONS.MOVE_EAST);
  }

  /**
   * Fallback heuristic logic when only the 19-element feature vector is supplied
   * @private
   */
  _selectActionFromFeatures(f) {
    const healthNorm = f[0];
    const foodNorm = f[1];
    const isNight = f[2] > 0.5;
    const nearbyThreats = f[4] > 0;
    const hasFood = f[7] > 0.5;
    const currentCellHasRes = f[9] > 0.5;
    const hasShelter = f[11] > 0.5;
    const hasSword = f[14] > 0.5;
    const canCraftAnything = f[15] > 0.5;

    // 1. health < 5 (5/20 = 0.25)
    if (healthNorm < 0.25 && hasFood) {
      return this._formatAction(ACTIONS.EAT_RAW);
    }

    // 2. food < 8 (8/20 = 0.4)
    if (foodNorm < 0.4 && hasFood) {
      return this._formatAction(ACTIONS.EAT_RAW);
    }

    // 3 & 4. threat
    if (nearbyThreats) {
      return this._formatAction(hasSword ? ACTIONS.ATTACK : ACTIONS.FLEE);
    }

    // 5. night and shelter
    if (isNight && hasShelter) {
      return this._formatAction(ACTIONS.GOTO_SHELTER);
    }

    // 6. night and no shelter and can craft
    if (isNight && !hasShelter && canCraftAnything) {
      return this._formatAction(ACTIONS.CRAFT, 'shelter_kit');
    }

    // 8. current cell resource
    if (currentCellHasRes) {
      return this._formatAction(ACTIONS.GATHER);
    }

    // 9. can craft tool
    if (canCraftAnything) {
      return this._formatAction(ACTIONS.CRAFT, 'wooden_pickaxe');
    }

    // 10. move toward resource
    return this._formatAction(ACTIONS.MOVE_EAST);
  }

  /**
   * Formats action name and craftTarget into full result object
   * @private
   */
  _formatAction(actionName, craftTarget = null) {
    const actionIndex = getActionIndex(actionName, craftTarget);
    return {
      actionIndex,
      actionName,
      craftTarget,
      confidence: 1.0
    };
  }

  clone() {
    return new HeuristicPolicy({
      metadata: { ...this.metadata }
    });
  }

  serialize() {
    return {
      type: 'HeuristicPolicy',
      id: this.id,
      generation: this.generation,
      fitness: this.fitness,
      metadata: { ...this.metadata }
    };
  }

  static deserialize(data) {
    const p = new HeuristicPolicy({
      id: data.id,
      metadata: data.metadata
    });
    p.generation = data.generation ?? 0;
    p.fitness = data.fitness ?? 0;
    return p;
  }
}
