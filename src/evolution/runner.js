/**
 * Accelerated Headless Parallel Simulation Runner & Experience Store for MIKA
 * E:\MIKA\src\evolution\runner.js
 *
 * Orchestrates high-throughput simulation episodes concurrently, manages experiment
 * checkpoints, logs generational metrics, and tracks virtual simulation time.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { SimWorld, WorldConfig, ACTIONS } from './world.js';

/**
 * Array of all standard simulation actions for fast random/fallback sampling
 */
const ALL_ACTIONS = Object.freeze(Object.values(ACTIONS));

/**
 * Helper to extract an action and optional crafting target from a policy decision
 *
 * @param {any} policy - Policy function or object with act/decide/step method
 * @param {object} observation - World observation
 * @returns {{ action: string, craftTarget: string|null }}
 */
export function resolvePolicyAction(policy, observation) {
  let decision = ACTIONS.IDLE;
  try {
    if (typeof policy === 'function') {
      decision = policy(observation);
    } else if (policy && typeof policy.act === 'function') {
      decision = policy.act(observation);
    } else if (policy && typeof policy.decide === 'function') {
      decision = policy.decide(observation);
    } else if (policy && typeof policy.step === 'function') {
      decision = policy.step(observation);
    }
  } catch {
    decision = ACTIONS.IDLE;
  }

  if (typeof decision === 'string') {
    return { action: decision, craftTarget: null };
  }

  if (decision && typeof decision === 'object') {
    return {
      action: decision.action || decision.actionId || ACTIONS.IDLE,
      craftTarget: decision.craftTarget || decision.target || null
    };
  }

  return { action: ACTIONS.IDLE, craftTarget: null };
}

/**
 * Computes a standardized fitness score from SimWorld metrics
 *
 * @param {object} metrics - Metrics returned by SimWorld.getMetrics()
 * @returns {number}
 */
export function calculateEpisodeFitness(metrics) {
  if (!metrics) return 0;
  let fitness = 0;
  fitness += (metrics.ticksSurvived || 0) * 1.0;
  fitness += (metrics.inventoryValue || 0) * 5.0;
  fitness += (metrics.totalCrafted || 0) * 10.0;
  fitness += (metrics.totalResourcesGathered || 0) * 2.0;
  fitness += (metrics.totalThreatsAvoided || 0) * 8.0;
  if (metrics.builtShelter) fitness += 50.0;
  return fitness;
}

/**
 * Concurrency Limiter / Promise Pool
 *
 * @template T, R
 * @param {T[]} items - Array of input items
 * @param {number} limit - Maximum concurrent executions
 * @param {(item: T, index: number) => Promise<R>} iterator - Worker function
 * @returns {Promise<R[]>}
 */
export async function runConcurrentPool(items, limit, iterator) {
  if (!items || items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await iterator(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * VirtualTimeTracker
 *
 * Tracks elapsed simulation virtual time (ticks, days, years) versus real wall-clock time.
 */
export class VirtualTimeTracker {
  /**
   * @param {object} [options={}]
   * @param {number} [options.ticksPerDay=1200] - Simulation ticks per day
   */
  constructor(options = {}) {
    this.ticksPerDay = options.ticksPerDay || 1200;
    this.virtualTicksCompleted = 0;
    this.episodesCompleted = 0;
    this.generationsCompleted = 0;
    this.wallClockMs = 0;
  }

  /**
   * Virtual days elapsed
   * @returns {number}
   */
  get virtualDaysCompleted() {
    return this.virtualTicksCompleted / this.ticksPerDay;
  }

  /**
   * Virtual years elapsed (assuming 365 days per virtual year)
   * @returns {number}
   */
  get virtualYearsCompleted() {
    return this.virtualDaysCompleted / 365;
  }

  /**
   * Virtual ticks processed per second of wall clock
   * @returns {number}
   */
  get ticksPerSecond() {
    if (this.wallClockMs <= 0) return 0;
    return (this.virtualTicksCompleted / (this.wallClockMs / 1000));
  }

  /**
   * Updates tracker with newly completed episode metrics
   *
   * @param {number} [episodeTicks=0]
   * @param {number} [wallMs=0]
   */
  update(episodeTicks = 0, wallMs = 0) {
    this.virtualTicksCompleted += episodeTicks;
    this.episodesCompleted += 1;
    this.wallClockMs += wallMs;
  }

  /**
   * Records completed generation
   */
  recordGeneration() {
    this.generationsCompleted += 1;
  }

  /**
   * Returns a complete structured summary of time metrics
   *
   * @returns {object}
   */
  getSummary() {
    return {
      virtualTicksCompleted: this.virtualTicksCompleted,
      virtualDaysCompleted: Number(this.virtualDaysCompleted.toFixed(2)),
      virtualYearsCompleted: Number(this.virtualYearsCompleted.toFixed(4)),
      episodesCompleted: this.episodesCompleted,
      generationsCompleted: this.generationsCompleted,
      wallClockMs: Math.round(this.wallClockMs),
      ticksPerSecond: Math.round(this.ticksPerSecond)
    };
  }

  /**
   * Formats a human-readable progress line
   *
   * @returns {string}
   */
  getProgressString() {
    const vDays = this.virtualDaysCompleted.toFixed(1);
    const vYears = this.virtualYearsCompleted.toFixed(2);
    const wallSec = (this.wallClockMs / 1000).toFixed(1);
    const tps = Math.round(this.ticksPerSecond);
    return `[TimeTracker] Episodes: ${this.episodesCompleted} | Gen: ${this.generationsCompleted} | Virtual: ${vDays}d (${vYears}y) | Real: ${wallSec}s | Speed: ${tps} ticks/s`;
  }
}

/**
 * ExperienceStore
 *
 * Persistent storage for evolution checkpoints, generation logs,
 * best policies, and experiment summaries in data/evolution/
 */
export class ExperienceStore {
  /**
   * @param {object} [options={}]
   * @param {string} [options.dataDir] - Path to data/evolution/
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir
      ? path.resolve(options.dataDir)
      : path.resolve(process.cwd(), 'data', 'evolution');

    this.checkpointsDir = path.join(this.dataDir, 'checkpoints');
    this.bestPoliciesDir = path.join(this.dataDir, 'best-policies');

    this._ensureDirectories();
  }

  /**
   * Ensures necessary directory structure exists
   * @private
   */
  _ensureDirectories() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.checkpointsDir)) {
      fs.mkdirSync(this.checkpointsDir, { recursive: true });
    }
    if (!fs.existsSync(this.bestPoliciesDir)) {
      fs.mkdirSync(this.bestPoliciesDir, { recursive: true });
    }
  }

  /**
   * Saves an engine checkpoint to checkpoints/checkpoint-${label}.json
   *
   * @param {object} engine - EvolutionEngine instance or state object
   * @param {string|number} label - Identifier for the checkpoint
   * @returns {Promise<string>} Path to saved checkpoint
   */
  async saveCheckpoint(engine, label) {
    this._ensureDirectories();
    let data;
    if (engine && typeof engine.serialize === 'function') {
      data = engine.serialize();
    } else if (engine && typeof engine.toJSON === 'function') {
      data = engine.toJSON();
    } else if (engine && typeof engine.getCheckpointData === 'function') {
      data = engine.getCheckpointData();
    } else {
      data = engine;
    }

    const checkpointPayload = {
      label: String(label),
      savedAt: new Date().toISOString(),
      engineState: data
    };

    const filePath = path.join(this.checkpointsDir, `checkpoint-${label}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(checkpointPayload, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Loads and returns checkpoint data
   *
   * @param {string|number} label - Checkpoint label or file name
   * @returns {Promise<object>} Checkpoint data
   */
  async loadCheckpoint(label) {
    const rawLabel = String(label).replace(/^checkpoint-/, '').replace(/\.json$/, '');
    const filePath = path.join(this.checkpointsDir, `checkpoint-${rawLabel}.json`);
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed.engineState !== undefined ? parsed.engineState : parsed;
  }

  /**
   * Lists all available checkpoint labels
   *
   * @returns {Promise<string[]>}
   */
  async listCheckpoints() {
    this._ensureDirectories();
    const files = await fs.promises.readdir(this.checkpointsDir);
    return files
      .filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'))
      .map((f) => f.slice('checkpoint-'.length, -'.json'.length));
  }

  /**
   * Appends a generation report to generations.jsonl
   *
   * @param {object} report - Generational report object
   * @returns {Promise<string>} Path to generations.jsonl
   */
  async saveGenerationLog(report) {
    this._ensureDirectories();
    const filePath = path.join(this.dataDir, 'generations.jsonl');
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...report
    }) + '\n';
    await fs.promises.appendFile(filePath, line, 'utf-8');
    return filePath;
  }

  /**
   * Saves best policy to best-policies/gen-${generation}.json
   *
   * @param {any} policy - Best policy representation
   * @param {number} fitness - Best policy fitness
   * @param {number} generation - Generation index
   * @returns {Promise<string>} Path to saved policy file
   */
  async saveBestPolicy(policy, fitness, generation) {
    this._ensureDirectories();
    let serializedPolicy = policy;
    if (policy && typeof policy.toJSON === 'function') {
      serializedPolicy = policy.toJSON();
    } else if (policy && typeof policy.serialize === 'function') {
      serializedPolicy = policy.serialize();
    }

    const payload = {
      generation,
      fitness,
      savedAt: new Date().toISOString(),
      policy: serializedPolicy
    };

    const filePath = path.join(this.bestPoliciesDir, `gen-${generation}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Saves final experiment summary to experiment-summary.json
   *
   * @param {object} summary - Experiment summary data
   * @returns {Promise<string>} Path to saved summary file
   */
  async saveExperimentSummary(summary) {
    this._ensureDirectories();
    const filePath = path.join(this.dataDir, 'experiment-summary.json');
    const payload = {
      savedAt: new Date().toISOString(),
      ...summary
    };
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  }
}

/**
 * Default fallback EvolutionEngine used when no external engine is provided.
 * Implements standard GA population cycle (evaluation, selection, mutation, elitism).
 */
export class DefaultEvolutionEngine {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.populationSize = options.populationSize || 20;
    this.mutationRate = options.mutationRate ?? 0.15;
    this.elitismCount = options.elitismCount ?? 2;
    this.generation = 0;
    this.bestFitness = 0;
    this.bestPolicy = null;
    this.history = [];

    // Initialize randomized rule/weight vector policies
    this.population = Array.from({ length: this.populationSize }, (_, idx) =>
      this._createRandomPolicy(idx)
    );
  }

  /**
   * Creates a random rule-based policy with action preferences
   * @private
   */
  _createRandomPolicy(id) {
    const weights = {};
    for (const act of ALL_ACTIONS) {
      weights[act] = Math.random();
    }
    return {
      id: `policy_${id}_g${this.generation}`,
      weights,
      act(obs) {
        // Simple reflex heuristics biased by genome weights
        if (obs.currentCell?.threat) return ACTIONS.FLEE;
        if (obs.agent.food < 12 && obs.inventory.FOOD > 0) return ACTIONS.EAT_RAW;
        if (obs.currentCell?.resource) return ACTIONS.GATHER;
        // Weighted random choice across actions
        let bestScore = -Infinity;
        let chosenAction = ACTIONS.MOVE_EAST;
        for (const [action, weight] of Object.entries(this.weights)) {
          const score = weight + Math.random() * 0.1;
          if (score > bestScore) {
            bestScore = score;
            chosenAction = action;
          }
        }
        return chosenAction;
      },
      toJSON() {
        return { id: this.id, weights: { ...this.weights } };
      }
    };
  }

  /**
   * Returns the best policy discovered
   */
  getBestPolicy() {
    return this.bestPolicy;
  }

  /**
   * Advances one evolutionary generation
   *
   * @param {ParallelRunner} runner
   * @param {number[]} [seeds=[101, 102, 103]]
   * @param {WorldConfig|object} [worldConfig]
   * @returns {Promise<object>} Generational report
   */
  async nextGeneration(runner, seeds = [101, 102], worldConfig) {
    this.generation++;

    // Evaluate entire population across seeds concurrently
    const evalResults = await runner.runEpisodeBatch(this.population, seeds, worldConfig);

    // Group evaluation results by policy index
    const policyScores = new Map();
    let totalTicks = 0;

    for (const res of evalResults) {
      totalTicks += res.ticks;
      const idx = res.policyIndex;
      if (!policyScores.has(idx)) {
        policyScores.set(idx, { totalFitness: 0, count: 0, policy: res.policy });
      }
      const entry = policyScores.get(idx);
      entry.totalFitness += res.fitness;
      entry.count += 1;
    }

    const scored = [];
    for (const [idx, data] of policyScores.entries()) {
      const avgFitness = data.totalFitness / (data.count || 1);
      scored.push({ index: idx, policy: data.policy, fitness: avgFitness });
    }

    // Sort descending by fitness
    scored.sort((a, b) => b.fitness - a.fitness);

    const bestOfGen = scored[0];
    if (bestOfGen && bestOfGen.fitness >= this.bestFitness) {
      this.bestFitness = bestOfGen.fitness;
      this.bestPolicy = bestOfGen.policy;
    }

    const totalFitnessSum = scored.reduce((sum, item) => sum + item.fitness, 0);
    const avgFitness = totalFitnessSum / (scored.length || 1);

    // Form next population via elitism and mutation
    const nextPop = [];
    // 1. Elites
    for (let i = 0; i < Math.min(this.elitismCount, scored.length); i++) {
      nextPop.push(scored[i].policy);
    }
    // 2. Offspring
    while (nextPop.length < this.populationSize) {
      const parent = scored[Math.floor(Math.random() * Math.min(5, scored.length))].policy;
      const childWeights = {};
      for (const act of ALL_ACTIONS) {
        let w = parent.weights?.[act] ?? Math.random();
        if (Math.random() < this.mutationRate) {
          w = Math.max(0, Math.min(1, w + (Math.random() * 0.4 - 0.2)));
        }
        childWeights[act] = w;
      }
      nextPop.push({
        id: `policy_${nextPop.length}_g${this.generation}`,
        weights: childWeights,
        act: parent.act,
        toJSON: parent.toJSON
      });
    }

    this.population = nextPop;

    const report = {
      generation: this.generation,
      bestFitness: bestOfGen ? bestOfGen.fitness : 0,
      avgFitness,
      bestPolicy: this.bestPolicy,
      totalTicks,
      episodes: evalResults.length
    };

    this.history.push(report);
    return report;
  }

  /**
   * Serializes engine state for checkpointing
   */
  toJSON() {
    return {
      generation: this.generation,
      bestFitness: this.bestFitness,
      bestPolicy: this.bestPolicy?.toJSON ? this.bestPolicy.toJSON() : this.bestPolicy,
      populationSize: this.populationSize,
      historyLength: this.history.length
    };
  }

  /**
   * Restores state from checkpoint
   */
  loadCheckpoint(data) {
    if (data) {
      this.generation = data.generation || 0;
      this.bestFitness = data.bestFitness || 0;
      this.populationSize = data.populationSize || this.populationSize;
    }
  }
}

/**
 * ParallelRunner
 *
 * Runs multiple simulation episodes concurrently using Promise pools,
 * benchmarks simulation throughput, and orchestrates full evolution experiments.
 */
export class ParallelRunner {
  /**
   * @param {object} [options={}]
   * @param {number} [options.maxConcurrent] - Maximum parallel episodes (default: cpus capped at 16)
   * @param {ExperienceStore} [options.experienceStore] - ExperienceStore instance
   */
  constructor(options = {}) {
    const detectedCpus = (os.cpus() && os.cpus().length) || 4;
    this.maxConcurrent = Math.max(1, Math.min(options.maxConcurrent || detectedCpus, 16));
    this.experienceStore = options.experienceStore || new ExperienceStore(options.storeOptions || {});
  }

  /**
   * Executes a single policy episode in SimWorld
   *
   * @param {any} policy - Agent policy
   * @param {number} seed - World seed
   * @param {WorldConfig|object} [worldConfig] - Simulation configuration
   * @param {number} [policyIndex=0] - Index in batch
   * @returns {object} Episode result
   */
  runSingleEpisode(policy, seed, worldConfig, policyIndex = 0) {
    const config = worldConfig instanceof WorldConfig ? worldConfig : new WorldConfig(worldConfig || {});
    const maxTicks = config.maxTicks || 2400;

    const startTime = performance.now();
    const world = new SimWorld(config, seed);

    while (world.agent.alive && world.currentTick < maxTicks) {
      const obs = world.getObservation();
      const { action, craftTarget } = resolvePolicyAction(policy, obs);
      world.tick(action, craftTarget);
    }

    const durationMs = performance.now() - startTime;
    const metrics = world.getMetrics();
    const fitness = calculateEpisodeFitness(metrics);

    return {
      policy,
      policyIndex,
      seed,
      ticks: world.currentTick,
      metrics,
      fitness,
      alive: world.agent.alive,
      deathCause: world.agent.deathCause,
      durationMs
    };
  }

  /**
   * Runs multiple policy-seed pairs concurrently using Promise pools.
   * Limits concurrency to maxConcurrent.
   *
   * @param {any[]} policies - Array of policies to evaluate
   * @param {number[]|number} seeds - World seeds
   * @param {WorldConfig|object} [worldConfig] - Simulation config overrides
   * @returns {Promise<object[]>} Array of episode results with timings
   */
  async runEpisodeBatch(policies, seeds = [12345], worldConfig = {}) {
    if (!policies || policies.length === 0) {
      return [];
    }

    // Build task execution list
    const tasks = [];

    if (Array.isArray(seeds)) {
      if (seeds.length === policies.length) {
        // 1-to-1 matching
        for (let i = 0; i < policies.length; i++) {
          tasks.push({
            policy: policies[i],
            seed: seeds[i],
            policyIndex: i
          });
        }
      } else {
        // Evaluate each policy on every seed (Cartesian product)
        for (let pi = 0; pi < policies.length; pi++) {
          for (let si = 0; si < seeds.length; si++) {
            tasks.push({
              policy: policies[pi],
              seed: seeds[si],
              policyIndex: pi
            });
          }
        }
      }
    } else {
      const baseSeed = typeof seeds === 'number' ? seeds : 12345;
      for (let i = 0; i < policies.length; i++) {
        tasks.push({
          policy: policies[i],
          seed: baseSeed + i,
          policyIndex: i
        });
      }
    }

    // Run tasks concurrently bounded by maxConcurrent
    return runConcurrentPool(tasks, this.maxConcurrent, async (task) => {
      return this.runSingleEpisode(task.policy, task.seed, worldConfig, task.policyIndex);
    });
  }

  /**
   * Runs a quick throughput benchmark with 100 episodes using random actions
   *
   * @param {object} [options={}]
   * @param {number} [options.episodes=100] - Benchmark episode count
   * @param {WorldConfig|object} [options.worldConfig] - World config
   * @returns {Promise<{ episodesPerSecond: number, avgEpisodeMs: number, totalMs: number }>}
   */
  async measureThroughput(options = {}) {
    const episodeCount = options.episodes || 100;
    const worldConfig = options.worldConfig || { maxTicks: 600 };

    const randomPolicy = () => ALL_ACTIONS[Math.floor(Math.random() * ALL_ACTIONS.length)];
    const policies = Array.from({ length: episodeCount }, () => randomPolicy);
    const seeds = Array.from({ length: episodeCount }, (_, i) => 20000 + i);

    const startTime = performance.now();
    await this.runEpisodeBatch(policies, seeds, worldConfig);
    const totalMs = performance.now() - startTime;

    const episodesPerSecond = totalMs > 0 ? (episodeCount / (totalMs / 1000)) : 0;
    const avgEpisodeMs = episodeCount > 0 ? (totalMs / episodeCount) : 0;

    return {
      episodesPerSecond: Number(episodesPerSecond.toFixed(2)),
      avgEpisodeMs: Number(avgEpisodeMs.toFixed(2)),
      totalMs: Number(totalMs.toFixed(2))
    };
  }

  /**
   * Main entry point for running a full evolution experiment
   *
   * @param {object} [options={}]
   * @param {number} [options.generations=10] - Number of generations
   * @param {number} [options.populationSize=20] - Population size
   * @param {number[]} [options.seeds] - Generational evaluation seeds
   * @param {number} [options.checkpointInterval=5] - How often to checkpoint
   * @param {boolean} [options.verbose=true] - Log progress to console
   * @param {number} [options.maxWallClockMs=Infinity] - Maximum wall-clock time limit
   * @param {number} [options.memoryLimitMB=2048] - Memory limit in MB
   * @param {object} [options.engine] - Pre-instantiated evolution engine
   * @param {Function} [options.EvolutionEngine] - Engine constructor
   * @param {WorldConfig|object} [options.worldConfig] - World configuration overrides
   * @returns {Promise<object>} Complete experiment results
   */
  async runEvolutionExperiment(options = {}) {
    const generations = options.generations || 10;
    const populationSize = options.populationSize || 20;
    const evalSeeds = options.seeds || [101, 102, 103];
    const checkpointInterval = options.checkpointInterval || 5;
    const verbose = options.verbose ?? true;
    const maxWallClockMs = options.maxWallClockMs || Infinity;
    const memoryLimitMB = options.memoryLimitMB || 2048;

    // Step 1: Initialize EvolutionEngine
    let engine = options.engine;
    if (!engine) {
      let EngineClass = options.EvolutionEngine;
      if (!EngineClass) {
        try {
          const mod = await import('./engine.js');
          EngineClass = mod.EvolutionEngine || mod.default;
        } catch {
          EngineClass = DefaultEvolutionEngine;
        }
      }
      engine = new (EngineClass || DefaultEvolutionEngine)({
        populationSize,
        seeds: evalSeeds,
        worldConfig: options.worldConfig,
        runner: this,
        ...(options.engineOptions || {})
      });
    }

    const timeTracker = new VirtualTimeTracker({
      ticksPerDay: options.worldConfig?.ticksPerDay || 1200
    });

    const experimentStartTime = performance.now();
    const generationReports = [];

    if (verbose) {
      console.log('====================================================');
      console.log('  MIKA Artificial-Life Evolution Experiment Starting');
      console.log(`  Generations: ${generations} | Population: ${populationSize}`);
      console.log(`  Concurrency: ${this.maxConcurrent} | Seeds: [${evalSeeds.join(', ')}]`);
      console.log('====================================================');
    }

    // Step 2: Generation loop
    for (let gen = 1; gen <= generations; gen++) {
      const genStartTime = performance.now();

      // a. Run nextGeneration()
      let report;
      if (typeof engine.nextGeneration === 'function') {
        report = await engine.nextGeneration(this, evalSeeds, options.worldConfig);
      } else {
        report = { generation: gen, bestFitness: 0, avgFitness: 0 };
      }

      const genDuration = performance.now() - genStartTime;
      timeTracker.recordGeneration();
      if (report && report.totalTicks) {
        timeTracker.update(report.totalTicks, genDuration);
      } else {
        timeTracker.update(0, genDuration);
      }

      generationReports.push(report);

      // b. Log generation report
      await this.experienceStore.saveGenerationLog(report);

      // c. Print progress if verbose
      if (verbose) {
        const bestFit = report.bestFitness != null ? Number(report.bestFitness).toFixed(2) : 'N/A';
        const avgFit = report.avgFitness != null ? Number(report.avgFitness).toFixed(2) : 'N/A';
        console.log(`[Gen ${gen}/${generations}] Best: ${bestFit} | Avg: ${avgFit} | ${Math.round(genDuration)}ms | ${timeTracker.getProgressString()}`);
      }

      // Save best policy if discovered
      if (report.bestPolicy) {
        await this.experienceStore.saveBestPolicy(report.bestPolicy, report.bestFitness || 0, gen);
      }

      // d. Checkpoint if needed
      if (gen % checkpointInterval === 0 || gen === generations) {
        await this.experienceStore.saveCheckpoint(engine, `gen-${gen}`);
      }

      // e. Check wall-clock and memory limits
      const totalElapsed = performance.now() - experimentStartTime;
      if (totalElapsed >= maxWallClockMs) {
        if (verbose) {
          console.warn(`[ParallelRunner] Wall-clock limit exceeded (${Math.round(totalElapsed)}ms >= ${maxWallClockMs}ms). Ending experiment.`);
        }
        break;
      }

      const memUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;
      if (memUsageMB >= memoryLimitMB) {
        if (verbose) {
          console.warn(`[ParallelRunner] Memory limit exceeded (${memUsageMB.toFixed(1)}MB >= ${memoryLimitMB}MB). Ending experiment.`);
        }
        break;
      }
    }

    // Step 3: Final held-out evaluation of best policy
    const bestPolicy = typeof engine.getBestPolicy === 'function' ? engine.getBestPolicy() : null;
    let heldOutResults = null;
    if (bestPolicy) {
      const heldOutSeeds = options.heldOutSeeds || [99001, 99002, 99003, 99004, 99005];
      const heldOutPolicies = new Array(heldOutSeeds.length).fill(bestPolicy);
      heldOutResults = await this.runEpisodeBatch(heldOutPolicies, heldOutSeeds, options.worldConfig);
    }

    // Step 4: Save experiment summary
    const totalWallClockMs = performance.now() - experimentStartTime;
    const finalBestFitness = engine.bestFitness || (heldOutResults ? heldOutResults.reduce((s, r) => s + r.fitness, 0) / heldOutResults.length : 0);

    const summary = {
      generationsRequested: generations,
      generationsCompleted: generationReports.length,
      populationSize,
      totalWallClockMs: Math.round(totalWallClockMs),
      finalBestFitness: Number(finalBestFitness.toFixed(2)),
      timeTracker: timeTracker.getSummary(),
      heldOutEvaluation: heldOutResults ? {
        episodeCount: heldOutResults.length,
        seeds: heldOutResults.map((r) => r.seed),
        avgFitness: Number((heldOutResults.reduce((s, r) => s + r.fitness, 0) / heldOutResults.length).toFixed(2)),
        avgTicksSurvived: Number((heldOutResults.reduce((s, r) => s + r.metrics.ticksSurvived, 0) / heldOutResults.length).toFixed(1))
      } : null,
      completedAt: new Date().toISOString()
    };

    await this.experienceStore.saveExperimentSummary(summary);

    if (verbose) {
      console.log('====================================================');
      console.log('  MIKA Evolution Experiment Complete!');
      console.log(`  Completed in ${(totalWallClockMs / 1000).toFixed(2)}s | Best Fitness: ${summary.finalBestFitness}`);
      console.log('====================================================\n');
    }

    // Step 5: Return complete results
    return {
      summary,
      engine,
      bestPolicy,
      heldOutResults,
      generationReports,
      timeTracker: timeTracker.getSummary()
    };
  }
}
