/**
 * Artificial-Life Accelerated Evolution Engine for MIKA
 * E:\MIKA\src\evolution\evolution.js
 *
 * Implements a genetic algorithm maintaining a population of agent policies,
 * evaluating them in headless simulated survival worlds, performing tournament
 * selection, crossover, mutation, and tracking fitness progress against baselines.
 */

import { SimWorld, ACTIONS, RECIPES, SeededRandom } from './world.js';

/**
 * Configuration options for the Evolution Engine
 */
export class EvolutionConfig {
  /**
   * @param {Partial<EvolutionConfig>} [overrides={}]
   */
  constructor(overrides = {}) {
    this.populationSize = 50;
    this.eliteCount = 5;
    this.mutationRate = 0.1;
    this.mutationStrength = 0.3;
    this.crossoverRate = 0.3;
    this.tournamentSize = 5;
    this.numEvalEpisodes = 3;
    this.maxEpisodeTicks = 2400;
    this.heldOutSeeds = [99999, 99998, 99997];
    this.baselineCheckInterval = 5;

    if (overrides) {
      Object.assign(this, overrides);
    }
  }
}

/**
 * Computes scalar fitness from simulation episode metrics
 */
export class FitnessCalculator {
  /**
   * Calculate scalar fitness from episode metrics:
   * fitness =
   *   ticksSurvived * 1.0 +
   *   totalResourcesGathered * 2.0 +
   *   totalCrafted * 5.0 +
   *   totalFoodEaten * 1.5 +
   *   (builtShelter ? 20.0 : 0) +
   *   toolCount * 10.0 +
   *   inventoryValue * 0.5 +
   *   (alive ? 50.0 : 0) -
   *   totalDamageTaken * 1.0
   *
   * @param {object} metrics
   * @returns {number}
   */
  static compute(metrics) {
    if (!metrics) return 0;
    const ticksSurvived = Number(metrics.ticksSurvived || 0);
    const totalResourcesGathered = Number(metrics.totalResourcesGathered || 0);
    const totalCrafted = Number(metrics.totalCrafted || 0);
    const totalFoodEaten = Number(metrics.totalFoodEaten || 0);
    const builtShelter = Boolean(metrics.builtShelter);
    const toolCount = Number(metrics.toolCount || 0);
    const inventoryValue = Number(metrics.inventoryValue || 0);
    const alive = Boolean(metrics.alive);
    const totalDamageTaken = Number(metrics.totalDamageTaken || 0);

    return (
      ticksSurvived * 1.0 +
      totalResourcesGathered * 2.0 +
      totalCrafted * 5.0 +
      totalFoodEaten * 1.5 +
      (builtShelter ? 20.0 : 0) +
      toolCount * 10.0 +
      inventoryValue * 0.5 +
      (alive ? 50.0 : 0) -
      totalDamageTaken * 1.0
    );
  }

  /**
   * Alias for compute()
   * @param {object} metrics
   * @returns {number}
   */
  static calculate(metrics) {
    return FitnessCalculator.compute(metrics);
  }

  /**
   * Calculate average fitness across an array of episodes or metrics objects
   * @param {Array<object|number>} episodes
   * @returns {number}
   */
  static average(episodes) {
    if (!episodes || episodes.length === 0) return 0;
    const sum = episodes.reduce((acc, ep) => {
      if (typeof ep === 'number') return acc + ep;
      if (ep && typeof ep.fitness === 'number') return acc + ep.fitness;
      return acc + FitnessCalculator.compute(ep);
    }, 0);
    return sum / episodes.length;
  }

  /**
   * Alias for average()
   * @param {Array<object|number>} episodes
   * @returns {number}
   */
  static calculateAverageFitness(episodes) {
    return FitnessCalculator.average(episodes);
  }
}

/**
 * List of available action identifiers
 */
const ACTION_KEYS = Object.values(ACTIONS);

/**
 * List of available recipe keys
 */
const RECIPE_KEYS = Object.keys(RECIPES);

/**
 * Parameterized Neural / Linear Survival Policy
 */
export class Policy {
  /**
   * @param {object} [options={}]
   * @param {string} [options.id]
   * @param {number[][]} [options.weights] - [actionCount][featureCount]
   * @param {number[]} [options.biases] - [actionCount]
   * @param {number[]} [options.craftWeights] - [recipeCount]
   */
  constructor({ id = null, weights = null, biases = null, craftWeights = null } = {}) {
    this.id = id || `policy_${Math.random().toString(36).slice(2, 9)}`;
    this.fitness = null;
    this.lastEvaluation = null;

    const actionCount = ACTION_KEYS.length;
    const featureCount = 16;
    const recipeCount = RECIPE_KEYS.length;

    if (weights) {
      this.weights = weights.map((row) => Array.from(row));
    } else {
      this.weights = Array.from({ length: actionCount }, () =>
        new Array(featureCount).fill(0)
      );
    }

    if (biases) {
      this.biases = Array.from(biases);
    } else {
      this.biases = new Array(actionCount).fill(0);
    }

    if (craftWeights) {
      this.craftWeights = Array.from(craftWeights);
    } else {
      this.craftWeights = new Array(recipeCount).fill(0);
    }
  }

  /**
   * Creates a randomly initialized policy using a seeded random generator
   * @param {SeededRandom} rng
   * @param {string} [id]
   * @returns {Policy}
   */
  static createRandom(rng, id = null) {
    const actionCount = ACTION_KEYS.length;
    const featureCount = 16;
    const recipeCount = RECIPE_KEYS.length;

    const weights = [];
    for (let a = 0; a < actionCount; a++) {
      const row = [];
      for (let f = 0; f < featureCount; f++) {
        row.push(rng.float(-1.0, 1.0));
      }
      weights.push(row);
    }

    const biases = [];
    for (let a = 0; a < actionCount; a++) {
      biases.push(rng.float(-0.5, 0.5));
    }

    const craftWeights = [];
    for (let r = 0; r < recipeCount; r++) {
      craftWeights.push(rng.float(-1.0, 1.0));
    }

    return new Policy({ id, weights, biases, craftWeights });
  }

  /**
   * Extracts a normalized 16-element feature vector from world observation
   * @param {object} obs
   * @returns {number[]}
   */
  extractFeatures(obs) {
    const health = (obs.agent.health || 0) / 20;
    const food = (obs.agent.food || 0) / 20;
    const hasRawFood = (obs.inventory?.FOOD || 0) > 0 ? 1 : 0;
    const hasCookedFood = (obs.inventory?.cooked_food || 0) > 0 ? 1 : 0;
    const hasShelterKit = (obs.inventory?.shelter_kit || 0) > 0 ? 1 : 0;
    const hasShelter = obs.hasShelter ? 1 : 0;
    const isNight = obs.isNight ? 1 : 0;
    const cellResource = obs.currentCell?.resource ? 1 : 0;
    const cellThreat = obs.currentCell?.threat ? 1 : 0;
    const threatNearby = obs.nearbyThreats?.length > 0 ? 1 : 0;
    const resourceNearby = obs.nearbyResources?.length > 0 ? 1 : 0;
    const woodNorm = Math.min(1, (obs.inventory?.WOOD || 0) / 5);
    const stoneNorm = Math.min(1, (obs.inventory?.STONE || 0) / 3);
    const hasPickaxe =
      obs.tools?.includes('wooden_pickaxe') || obs.tools?.includes('stone_pickaxe') ? 1 : 0;
    const hasSword =
      obs.tools?.includes('wooden_sword') || obs.tools?.includes('stone_sword') ? 1 : 0;
    const shelterDistNorm = obs.shelterDistance > 0 ? Math.min(1, obs.shelterDistance / 10) : 0;

    return [
      health,
      food,
      hasRawFood,
      hasCookedFood,
      hasShelterKit,
      hasShelter,
      isNight,
      cellResource,
      cellThreat,
      threatNearby,
      resourceNearby,
      woodNorm,
      stoneNorm,
      hasPickaxe,
      hasSword,
      shelterDistNorm
    ];
  }

  /**
   * Choose an action based on observation
   * @param {object} obs
   * @returns {{ action: string, craftTarget: string|null }}
   */
  act(obs) {
    const features = this.extractFeatures(obs);

    let bestScore = -Infinity;
    let bestActionIdx = 0;

    for (let a = 0; a < ACTION_KEYS.length; a++) {
      let score = this.biases[a];
      const row = this.weights[a];
      for (let f = 0; f < features.length; f++) {
        score += row[f] * features[f];
      }
      if (score > bestScore) {
        bestScore = score;
        bestActionIdx = a;
      }
    }

    const action = ACTION_KEYS[bestActionIdx];
    let craftTarget = null;

    if (action === ACTIONS.CRAFT) {
      let bestCraftScore = -Infinity;
      let bestRecipeIdx = 0;
      for (let r = 0; r < RECIPE_KEYS.length; r++) {
        if (this.craftWeights[r] > bestCraftScore) {
          bestCraftScore = this.craftWeights[r];
          bestRecipeIdx = r;
        }
      }
      craftTarget = RECIPE_KEYS[bestRecipeIdx];
    }

    return { action, craftTarget };
  }

  /**
   * Alias for act()
   * @param {object} obs
   * @returns {{ action: string, craftTarget: string|null }}
   */
  decide(obs) {
    return this.act(obs);
  }

  /**
   * Mutate weights and biases in-place
   * @param {number} rate
   * @param {number} strength
   * @param {SeededRandom} rng
   */
  mutate(rate, strength, rng) {
    for (let a = 0; a < this.weights.length; a++) {
      if (rng.next() < rate) {
        this.biases[a] += rng.float(-strength, strength);
      }
      for (let f = 0; f < this.weights[a].length; f++) {
        if (rng.next() < rate) {
          this.weights[a][f] += rng.float(-strength, strength);
        }
      }
    }
    for (let r = 0; r < this.craftWeights.length; r++) {
      if (rng.next() < rate) {
        this.craftWeights[r] += rng.float(-strength, strength);
      }
    }
  }

  /**
   * Performs uniform crossover with another policy to produce an offspring
   * @param {Policy} other
   * @param {SeededRandom} rng
   * @returns {Policy}
   */
  crossover(other, rng) {
    const childWeights = this.weights.map((row, a) =>
      row.map((val, f) => (rng.bool(0.5) ? val : other.weights[a][f]))
    );

    const childBiases = this.biases.map((b, a) =>
      rng.bool(0.5) ? b : other.biases[a]
    );

    const childCraft = this.craftWeights.map((w, r) =>
      rng.bool(0.5) ? w : other.craftWeights[r]
    );

    return new Policy({
      id: `child_${Math.random().toString(36).slice(2, 8)}`,
      weights: childWeights,
      biases: childBiases,
      craftWeights: childCraft
    });
  }

  /**
   * Clone policy
   * @returns {Policy}
   */
  clone() {
    const p = new Policy({
      id: this.id,
      weights: this.weights,
      biases: this.biases,
      craftWeights: this.craftWeights
    });
    p.fitness = this.fitness;
    return p;
  }

  /**
   * Serialize policy for storage
   * @returns {object}
   */
  serialize() {
    return {
      type: 'Policy',
      id: this.id,
      weights: this.weights,
      biases: this.biases,
      craftWeights: this.craftWeights,
      fitness: this.fitness
    };
  }

  /**
   * Deserialize policy from data
   * @param {object} data
   * @returns {Policy|HeuristicPolicy|RandomPolicy}
   */
  static deserialize(data) {
    if (!data) return null;
    if (data.type === 'HeuristicPolicy' || data.type === 'heuristic') {
      return new HeuristicPolicy(data.id);
    }
    if (data.type === 'RandomPolicy' || data.type === 'random') {
      return new RandomPolicy(data.id);
    }
    const p = new Policy(data);
    if (data.fitness !== undefined) p.fitness = data.fitness;
    return p;
  }
}

/**
 * Baseline Hand-Crafted Heuristic Policy
 */
export class HeuristicPolicy {
  /**
   * @param {string} [id='heuristic_baseline']
   */
  constructor(id = 'heuristic_baseline') {
    this.id = id;
    this.fitness = null;
  }

  /**
   * Evaluate observation and return prioritized survival action
   * @param {object} obs
   * @returns {{ action: string, craftTarget: string|null }}
   */
  act(obs) {
    // 1. Combat & Threat Response
    if (obs.currentCell?.threat) {
      if (obs.agent.health > 8 || obs.tools.includes('wooden_sword') || obs.tools.includes('stone_sword')) {
        return { action: ACTIONS.ATTACK, craftTarget: null };
      }
      return { action: ACTIONS.FLEE, craftTarget: null };
    }

    if (obs.nearbyThreats && obs.nearbyThreats.length > 0) {
      const nearest = obs.nearbyThreats[0];
      if (nearest.distance <= 1) {
        if (obs.agent.health > 8) {
          return { action: ACTIONS.ATTACK, craftTarget: null };
        }
        return { action: ACTIONS.FLEE, craftTarget: null };
      }
    }

    // 2. Hunger Management
    if (obs.agent.food < 15) {
      if ((obs.inventory?.cooked_food || 0) > 0) {
        return { action: ACTIONS.EAT_COOKED, craftTarget: null };
      }
      if ((obs.inventory?.FOOD || 0) > 0) {
        return { action: ACTIONS.EAT_RAW, craftTarget: null };
      }
    }

    // 3. Nighttime Survival & Shelter
    if (obs.isNight) {
      if (obs.hasShelter) {
        if (obs.shelterDistance > 0) {
          return { action: ACTIONS.GOTO_SHELTER, craftTarget: null };
        }
        return { action: ACTIONS.IDLE, craftTarget: null };
      }
      if ((obs.inventory?.shelter_kit || 0) > 0) {
        return { action: ACTIONS.BUILD_SHELTER, craftTarget: null };
      }
    }

    // 4. Place Shelter if kit available and no shelter exists
    if (!obs.hasShelter && (obs.inventory?.shelter_kit || 0) > 0) {
      return { action: ACTIONS.BUILD_SHELTER, craftTarget: null };
    }

    // 5. Crafting Essentials
    const wood = obs.inventory?.WOOD || 0;
    const stone = obs.inventory?.STONE || 0;
    const food = obs.inventory?.FOOD || 0;

    // Craft shelter kit
    if (!obs.hasShelter && (obs.inventory?.shelter_kit || 0) === 0 && wood >= 5 && stone >= 3) {
      return { action: ACTIONS.CRAFT, craftTarget: 'shelter_kit' };
    }

    // Craft stone pickaxe
    if (!obs.tools.includes('stone_pickaxe') && stone >= 3 && wood >= 2) {
      return { action: ACTIONS.CRAFT, craftTarget: 'stone_pickaxe' };
    }

    // Craft wooden pickaxe
    if (!obs.tools.includes('wooden_pickaxe') && !obs.tools.includes('stone_pickaxe') && wood >= 3) {
      return { action: ACTIONS.CRAFT, craftTarget: 'wooden_pickaxe' };
    }

    // Craft swords
    if (!obs.tools.includes('stone_sword') && stone >= 2 && wood >= 1) {
      return { action: ACTIONS.CRAFT, craftTarget: 'stone_sword' };
    }
    if (!obs.tools.includes('wooden_sword') && !obs.tools.includes('stone_sword') && wood >= 2) {
      return { action: ACTIONS.CRAFT, craftTarget: 'wooden_sword' };
    }

    // Cook food
    if (food >= 1 && wood >= 1 && obs.agent.food < 17) {
      return { action: ACTIONS.CRAFT, craftTarget: 'cooked_food' };
    }

    // 6. Resource Gathering at current position
    if (obs.currentCell?.resource && obs.currentCell.resource.amount > 0) {
      return { action: ACTIONS.GATHER, craftTarget: null };
    }

    // 7. Navigation towards nearest resource
    if (obs.nearbyResources && obs.nearbyResources.length > 0) {
      // Prioritize food when hungry, wood/stone otherwise
      let target = obs.nearbyResources[0];
      if (obs.agent.food < 12) {
        const foodRes = obs.nearbyResources.find((r) => r.type === 'FOOD');
        if (foodRes) target = foodRes;
      }

      if (target.dx > 0) return { action: ACTIONS.MOVE_EAST, craftTarget: null };
      if (target.dx < 0) return { action: ACTIONS.MOVE_WEST, craftTarget: null };
      if (target.dy > 0) return { action: ACTIONS.MOVE_SOUTH, craftTarget: null };
      if (target.dy < 0) return { action: ACTIONS.MOVE_NORTH, craftTarget: null };
    }

    // 8. Exploration fallback
    return { action: ACTIONS.MOVE_EAST, craftTarget: null };
  }

  decide(obs) {
    return this.act(obs);
  }

  clone() {
    const copy = new HeuristicPolicy(this.id);
    copy.fitness = this.fitness;
    return copy;
  }

  mutate() {
    // Baseline heuristic is invariant to mutation
  }

  crossover() {
    return this.clone();
  }

  serialize() {
    return {
      type: 'HeuristicPolicy',
      id: this.id,
      fitness: this.fitness
    };
  }
}

/**
 * Baseline Purely Random Policy
 */
export class RandomPolicy {
  /**
   * @param {string} [id='random_baseline']
   */
  constructor(id = 'random_baseline') {
    this.id = id;
    this.fitness = null;
    this.rng = new SeededRandom(777);
  }

  act(obs, worldRng = null) {
    const rng = worldRng || this.rng;
    const action = rng.choice(ACTION_KEYS) || ACTIONS.IDLE;
    const craftTarget = action === ACTIONS.CRAFT ? rng.choice(RECIPE_KEYS) : null;
    return { action, craftTarget };
  }

  decide(obs) {
    return this.act(obs);
  }

  clone() {
    const copy = new RandomPolicy(this.id);
    copy.fitness = this.fitness;
    return copy;
  }

  mutate() {
    // Random baseline is invariant to mutation
  }

  crossover() {
    return this.clone();
  }

  serialize() {
    return {
      type: 'RandomPolicy',
      id: this.id,
      fitness: this.fitness
    };
  }
}

/**
 * Main Evolutionary Algorithm Engine
 */
export class EvolutionEngine {
  /**
   * @param {Partial<EvolutionConfig>|EvolutionConfig} [config={}]
   */
  constructor(config = {}) {
    this.config = config instanceof EvolutionConfig ? config : new EvolutionConfig(config);
    this.population = [];
    this.generation = 0;
    this.history = [];
    this.bestEverPolicy = null;
    this.bestEverFitness = -Infinity;
    this.baselineFitness = null;
    this.heldOutResults = [];
    this.rng = new SeededRandom(12345);
    this.heuristicBaseline = new HeuristicPolicy();
    this.randomBaseline = new RandomPolicy();
    this.lastReport = null;
  }

  /**
   * Initializes population with random policies and baselines
   * @param {number} [seed=12345]
   * @returns {Policy[]}
   */
  initPopulation(seed = 12345) {
    this.rng = new SeededRandom(seed);
    this.population = [];

    for (let i = 0; i < this.config.populationSize; i++) {
      this.population.push(Policy.createRandom(this.rng, `gen0_ind_${i}`));
    }

    this.heuristicBaseline = new HeuristicPolicy();
    this.randomBaseline = new RandomPolicy();
    this.generation = 0;
    this.history = [];
    this.bestEverPolicy = null;
    this.bestEverFitness = -Infinity;
    this.baselineFitness = null;
    this.heldOutResults = [];
    this.lastReport = null;

    return this.population;
  }

  /**
   * Generates evaluation seeds deterministically from generation number
   * @param {number} gen
   * @returns {number[]}
   * @private
   */
  _getEvalSeeds(gen) {
    const seeds = [];
    for (let i = 0; i < this.config.numEvalEpisodes; i++) {
      // Deterministic generation-based seed distinct from heldOutSeeds
      seeds.push(((gen + 1) * 10007 + i * 37) >>> 0);
    }
    return seeds;
  }

  /**
   * Evaluates a single policy across given world seeds
   * @param {Policy|HeuristicPolicy|RandomPolicy} policy
   * @param {number[]} [seeds=null]
   * @returns {{ policyId: string, fitness: number, episodes: Array<object> }}
   */
  evaluatePolicy(policy, seeds = null) {
    const evalSeeds = seeds || this._getEvalSeeds(this.generation);
    const episodes = [];

    for (const seed of evalSeeds) {
      const world = new SimWorld({ maxTicks: this.config.maxEpisodeTicks }, seed);
      let obs = world.getObservation();

      for (let tick = 0; tick < this.config.maxEpisodeTicks; tick++) {
        if (!obs.agent.alive) break;

        const decision = policy.act ? policy.act(obs, world.rng) : policy.decide(obs);
        let actionId = ACTIONS.IDLE;
        let craftTarget = null;

        if (typeof decision === 'string') {
          actionId = decision;
        } else if (decision && typeof decision === 'object') {
          actionId = decision.action || decision.actionId || ACTIONS.IDLE;
          craftTarget = decision.craftTarget || decision.target || null;
        }

        obs = world.tick(actionId, craftTarget);
      }

      const metrics = world.getMetrics();
      const fitness = FitnessCalculator.compute(metrics);
      episodes.push({ seed, metrics, fitness });
    }

    const avgFitness =
      episodes.length > 0
        ? episodes.reduce((sum, ep) => sum + ep.fitness, 0) / episodes.length
        : 0;

    return {
      policyId: policy.id,
      fitness: avgFitness,
      episodes
    };
  }

  /**
   * Evaluates all policies in population and sorts them by fitness descending
   * @param {number[]} [seeds=null]
   * @returns {Array<object>} sorted results
   */
  evaluatePopulation(seeds = null) {
    const evalSeeds = seeds || this._getEvalSeeds(this.generation);
    const results = [];

    for (const policy of this.population) {
      const evalResult = this.evaluatePolicy(policy, evalSeeds);
      policy.fitness = evalResult.fitness;
      policy.lastEvaluation = evalResult;
      results.push(evalResult);
    }

    // Sort by fitness descending
    this.population.sort((a, b) => (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity));
    results.sort((a, b) => (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity));

    // Track best-ever policy
    if (this.population.length > 0 && this.population[0].fitness > this.bestEverFitness) {
      this.bestEverFitness = this.population[0].fitness;
      this.bestEverPolicy = this.population[0].clone();
    }

    return results;
  }

  /**
   * Evaluates a policy on held-out seeds to monitor overfitting
   * @param {Policy|HeuristicPolicy|RandomPolicy} policy
   * @returns {{ policyId: string, fitness: number, episodes: Array<object> }}
   */
  evaluateHeldOut(policy) {
    return this.evaluatePolicy(policy, this.config.heldOutSeeds);
  }

  /**
   * Tournament selection: pick tournamentSize random individuals, return the fittest
   * @param {Policy[]} [population=this.population]
   * @param {number[]|Map<string, number>} [fitnesses=null]
   * @returns {Policy}
   */
  selectParent(population = this.population, fitnesses = null) {
    const size = Math.min(this.config.tournamentSize, population.length);
    let bestIndividual = null;
    let bestFitness = -Infinity;

    for (let i = 0; i < size; i++) {
      const idx = Math.floor(this.rng.next() * population.length);
      const candidate = population[idx];

      let fitness = -Infinity;
      if (fitnesses) {
        if (Array.isArray(fitnesses)) {
          fitness = fitnesses[idx];
        } else if (fitnesses instanceof Map) {
          fitness = fitnesses.get(candidate.id) ?? candidate.fitness ?? -Infinity;
        } else if (typeof fitnesses === 'object') {
          fitness = fitnesses[candidate.id] ?? candidate.fitness ?? -Infinity;
        }
      } else {
        fitness = candidate.fitness !== undefined && candidate.fitness !== null
          ? candidate.fitness
          : -Infinity;
      }

      if (fitness > bestFitness || bestIndividual === null) {
        bestFitness = fitness;
        bestIndividual = candidate;
      }
    }

    return bestIndividual || population[0];
  }

  /**
   * Advances the simulation by one generation
   * @returns {object} generation report
   */
  nextGeneration() {
    const startTime = Date.now();

    // 1. Evaluate current population
    this.evaluatePopulation();

    // 2. Keep top eliteCount policies unchanged
    const newPopulation = [];
    const eliteCount = Math.min(this.config.eliteCount, this.population.length);
    for (let i = 0; i < eliteCount; i++) {
      newPopulation.push(this.population[i].clone());
    }

    // 3. Fill remaining slots with crossover or mutated clones
    while (newPopulation.length < this.config.populationSize) {
      if (this.rng.next() < this.config.crossoverRate) {
        const parent1 = this.selectParent(this.population);
        const parent2 = this.selectParent(this.population);
        const child = parent1.crossover(parent2, this.rng);
        child.mutate(this.config.mutationRate, this.config.mutationStrength, this.rng);
        newPopulation.push(child);
      } else {
        const parent = this.selectParent(this.population);
        const child = parent.clone();
        child.mutate(this.config.mutationRate, this.config.mutationStrength, this.rng);
        newPopulation.push(child);
      }
    }

    // 4. Every baselineCheckInterval generations, re-evaluate baselines
    if (this.baselineFitness === null || this.generation % this.config.baselineCheckInterval === 0) {
      const seeds = this._getEvalSeeds(this.generation);
      const hResult = this.evaluatePolicy(this.heuristicBaseline, seeds);
      const rResult = this.evaluatePolicy(this.randomBaseline, seeds);
      this.baselineFitness = {
        heuristic: hResult.fitness,
        random: rResult.fitness
      };
    }

    // 5. Record generation stats: best/avg/worst fitness, diversity, held-out performance
    const bestPolicy = this.population[0];
    const fitnesses = this.population.map((p) => p.fitness ?? 0);
    const bestFitness = fitnesses[0];
    const worstFitness = fitnesses[fitnesses.length - 1];
    const sumFitness = fitnesses.reduce((sum, f) => sum + f, 0);
    const avgFitness = fitnesses.length > 0 ? sumFitness / fitnesses.length : 0;

    const variance =
      fitnesses.length > 0
        ? fitnesses.reduce((sum, f) => sum + Math.pow(f - avgFitness, 2), 0) / fitnesses.length
        : 0;
    const populationDiversity = Math.sqrt(variance);

    // Held-out evaluation
    const heldOutEval = this.evaluateHeldOut(bestPolicy);
    const heldOutFitness = heldOutEval.fitness;
    this.heldOutResults.push({
      generation: this.generation,
      fitness: heldOutFitness,
      policyId: bestPolicy.id
    });

    // Improvement over baseline percentage
    const baselineRef =
      this.baselineFitness?.heuristic || this.baselineFitness?.random || 1;
    const improvementOverBaseline =
      baselineRef !== 0
        ? ((bestFitness - baselineRef) / Math.abs(baselineRef)) * 100
        : 0;

    const wallClockMs = Date.now() - startTime;

    const report = {
      generation: this.generation,
      bestFitness,
      avgFitness,
      worstFitness,
      bestPolicyId: bestPolicy.id,
      populationDiversity,
      heldOutFitness,
      baselineFitness: { ...this.baselineFitness },
      improvementOverBaseline,
      wallClockMs
    };

    this.history.push(report);
    this.lastReport = report;

    // 6. Update population and increment generation counter
    this.population = newPopulation;
    this.generation++;

    // 7. Return generation report
    return report;
  }

  /**
   * Returns latest generation report
   * @returns {object|null}
   */
  getGenerationReport() {
    if (this.lastReport) {
      return { ...this.lastReport };
    }
    if (this.history.length > 0) {
      return { ...this.history[this.history.length - 1] };
    }
    return null;
  }

  /**
   * Sequentially runs the evolutionary process for a given number of generations
   * @param {number} count
   * @param {object} [options={}]
   * @param {Function} [options.onGeneration] - callback(report)
   * @param {number} [options.checkpointInterval]
   * @param {Function} [options.onCheckpoint] - callback(checkpointData)
   * @param {number} [options.earlyStopNoImprovement]
   * @returns {Promise<object>}
   */
  async runForGenerations(count, options = {}) {
    const reports = [];
    const onGeneration = options.onGeneration || null;
    const checkpointInterval = options.checkpointInterval || null;
    const onCheckpoint = options.onCheckpoint || null;
    const earlyStopNoImprovement = options.earlyStopNoImprovement || null;

    let generationsWithoutImprovement = 0;
    let previousBest = this.bestEverFitness;

    for (let i = 0; i < count; i++) {
      const report = this.nextGeneration();
      reports.push(report);

      if (report.bestFitness > previousBest) {
        previousBest = report.bestFitness;
        generationsWithoutImprovement = 0;
      } else {
        generationsWithoutImprovement++;
      }

      if (typeof onGeneration === 'function') {
        await onGeneration(report);
      }

      if (checkpointInterval && this.generation % checkpointInterval === 0) {
        if (typeof onCheckpoint === 'function') {
          await onCheckpoint(this.checkpoint());
        }
      }

      if (
        earlyStopNoImprovement &&
        generationsWithoutImprovement >= earlyStopNoImprovement
      ) {
        break;
      }
    }

    return {
      totalGenerations: count,
      completedGenerations: reports.length,
      reports,
      bestEverFitness: this.bestEverFitness,
      bestEverPolicy: this.bestEverPolicy
    };
  }

  /**
   * Serializes current engine state to a JSON-serializable object
   * @returns {object}
   */
  checkpoint() {
    return {
      config: { ...this.config },
      generation: this.generation,
      history: JSON.parse(JSON.stringify(this.history)),
      bestEverPolicy: this.bestEverPolicy ? this.bestEverPolicy.serialize() : null,
      bestEverFitness: this.bestEverFitness,
      baselineFitness: this.baselineFitness ? { ...this.baselineFitness } : null,
      heldOutResults: JSON.parse(JSON.stringify(this.heldOutResults)),
      population: this.population.map((p) => (p.serialize ? p.serialize() : p)),
      rngSeed: this.rng ? this.rng.seed : 12345
    };
  }

  /**
   * Restores an engine from serialized checkpoint data
   * @param {object} checkpointData
   * @returns {EvolutionEngine}
   */
  static restore(checkpointData) {
    const engine = new EvolutionEngine(checkpointData.config);
    engine.generation = checkpointData.generation;
    engine.history = checkpointData.history || [];
    engine.bestEverFitness = checkpointData.bestEverFitness ?? -Infinity;
    engine.baselineFitness = checkpointData.baselineFitness || null;
    engine.heldOutResults = checkpointData.heldOutResults || [];

    if (checkpointData.rngSeed !== undefined) {
      engine.rng = new SeededRandom(checkpointData.rngSeed);
    }
    if (checkpointData.bestEverPolicy) {
      engine.bestEverPolicy = Policy.deserialize(checkpointData.bestEverPolicy);
    }
    if (checkpointData.population) {
      engine.population = checkpointData.population.map((pData) =>
        Policy.deserialize(pData)
      );
    }

    if (engine.history.length > 0) {
      engine.lastReport = engine.history[engine.history.length - 1];
    }

    return engine;
  }
}

export default EvolutionEngine;
