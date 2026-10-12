/**
 * Select, Rank, and Validate Top Evolved Policies for MIKA
 * E:\MIKA\src\evolution\select-top.js
 *
 * Extracts the top N policies (default: 20) from the latest or specified
 * evolution checkpoint, evaluates them across held-out survival benchmarks,
 * saves individual policy JSON files + top20 manifest, and prints a leaderboard.
 *
 * Usage:
 *   node src/evolution/select-top.js [options]
 *     --top N           Number of top policies to select (default: 20)
 *     --checkpoint PATH Checkpoint file to inspect (default: latest checkpoint)
 *     --episodes N      Evaluation episodes per policy for verification (default: 3)
 *     --ticks N         Max ticks per episode (default: 2400)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvolutionEngine, EvolutionConfig, FitnessCalculator } from './evolution.js';
import { SimWorld, WorldConfig } from './world.js';

export function parseSelectArgs(args = process.argv.slice(2)) {
  const options = {
    top: 20,
    checkpoint: null,
    episodes: 3,
    ticks: 2400,
    heldOutSeeds: [99999, 99998, 99997, 99996, 99995]
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--top' || arg === '-k') {
      options.top = parseInt(args[++i], 10);
    } else if (arg.startsWith('--top=')) {
      options.top = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--checkpoint' || arg === '-c') {
      options.checkpoint = args[++i];
    } else if (arg.startsWith('--checkpoint=')) {
      options.checkpoint = arg.split('=')[1];
    } else if (arg === '--episodes' || arg === '-e') {
      options.episodes = parseInt(args[++i], 10);
    } else if (arg.startsWith('--episodes=')) {
      options.episodes = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--ticks' || arg === '-t') {
      options.ticks = parseInt(args[++i], 10);
    } else if (arg.startsWith('--ticks=')) {
      options.ticks = parseInt(arg.split('=')[1], 10);
    }
  }

  return options;
}

/**
 * Finds the latest checkpoint file in data/evolution/checkpoints/
 * @param {string} [checkpointsDir]
 * @returns {string|null}
 */
export function findLatestCheckpoint(checkpointsDir = path.resolve(process.cwd(), 'data', 'evolution', 'checkpoints')) {
  if (!fs.existsSync(checkpointsDir)) return null;

  const files = fs.readdirSync(checkpointsDir)
    .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'));

  if (files.length === 0) return null;

  files.sort((a, b) => {
    const genA = parseInt((a.match(/checkpoint-gen-(\d+)/) || [])[1] || '0', 10);
    const genB = parseInt((b.match(/checkpoint-gen-(\d+)/) || [])[1] || '0', 10);
    if (genA && genB) return genB - genA;

    const statA = fs.statSync(path.join(checkpointsDir, a));
    const statB = fs.statSync(path.join(checkpointsDir, b));
    return statB.mtimeMs - statA.mtimeMs;
  });

  return path.join(checkpointsDir, files[0]);
}

/**
 * Main function to select and display the top N policies
 */
export async function selectTopPolicies(customOptions = null) {
  const defaults = parseSelectArgs([]);
  const options = { ...defaults, ...(customOptions || {}) };
  const checkpointPath = options.checkpoint || findLatestCheckpoint();

  if (!checkpointPath || !fs.existsSync(checkpointPath)) {
    console.error(`[Error] No checkpoint found at: ${checkpointPath || 'data/evolution/checkpoints/'}`);
    console.error('Please run evolution first: npm run evolve');
    process.exit(1);
  }

  console.log(`\n===============================================================`);
  console.log(`     MIKA ARTIFICIAL-LIFE: TOP ${options.top} SELECTION & LEADERBOARD   `);
  console.log(`===============================================================`);
  console.log(`Checkpoint Path : ${checkpointPath}`);
  console.log(`Target Selection: Top ${options.top} Policies`);
  console.log(`Validation Seeds: ${options.heldOutSeeds.length} held-out survival episodes\n`);

  // Load checkpoint and restore EvolutionEngine
  const rawContent = fs.readFileSync(checkpointPath, 'utf-8');
  const parsed = JSON.parse(rawContent);
  const engineState = parsed.engineState || parsed;

  const engine = EvolutionEngine.restore(engineState);
  const generation = engine.generation || 0;

  if (!engine.population || engine.population.length === 0) {
    console.error('[Error] Checkpoint contains an empty population.');
    return [];
  }

  // Sort population by training fitness descending
  engine.population.sort((a, b) => (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity));

  const selectCount = Math.min(options.top, engine.population.length);
  const topPolicies = engine.population.slice(0, selectCount);

  console.log(`Loaded generation ${generation} with ${engine.population.length} total individuals.`);
  console.log(`Evaluating top ${selectCount} policies on held-out survival benchmarks...\n`);

  // Prepare directories
  const dataDir = path.resolve(process.cwd(), 'data', 'evolution');
  const topPoliciesDir = path.join(dataDir, 'top-policies');
  if (!fs.existsSync(topPoliciesDir)) {
    fs.mkdirSync(topPoliciesDir, { recursive: true });
  }

  const leaderboard = [];

  for (let rank = 1; rank <= topPolicies.length; rank++) {
    const policy = topPolicies[rank - 1];
    
    // Evaluate across held-out seeds using engine evaluation logic
    const evalResult = engine.evaluatePolicy(policy, options.heldOutSeeds);

    let totalTicks = 0;
    let totalGathered = 0;
    let totalCrafted = 0;
    let totalFoodEaten = 0;
    let totalDamage = 0;
    let aliveCount = 0;
    const count = evalResult.episodes.length || 1;

    for (const ep of evalResult.episodes) {
      const m = ep.metrics || {};
      if (m.alive) aliveCount++;
      totalTicks += Number(m.ticksSurvived || 0);
      totalGathered += Number(m.totalResourcesGathered || 0);
      totalCrafted += Number(m.totalCrafted || 0);
      totalFoodEaten += Number(m.totalFoodEaten || 0);
      totalDamage += Number(m.totalDamageTaken || 0);
    }

    const survivalRate = Math.round((aliveCount / count) * 100);
    const avgTicks = Math.round(totalTicks / count);
    const avgGathered = Number((totalGathered / count).toFixed(1));
    const avgCrafted = Number((totalCrafted / count).toFixed(1));
    const avgFood = Number((totalFoodEaten / count).toFixed(1));
    const avgDamage = Number((totalDamage / count).toFixed(1));

    const entry = {
      rank,
      policyId: policy.id,
      generation: policy.generation ?? generation,
      trainingFitness: Number((policy.fitness || 0).toFixed(2)),
      heldOutFitness: Number(evalResult.fitness.toFixed(2)),
      survivalRate: `${survivalRate}%`,
      avgTicks,
      resourcesGathered: avgGathered,
      craftedItems: avgCrafted,
      foodEaten: avgFood,
      damageTaken: avgDamage,
      policy: policy.serialize ? policy.serialize() : policy
    };

    leaderboard.push(entry);

    // Save individual top policy
    const individualPath = path.join(topPoliciesDir, `rank-${String(rank).padStart(2, '0')}-${policy.id}.json`);
    fs.writeFileSync(individualPath, JSON.stringify(entry, null, 2), 'utf-8');
  }

  // Print Leaderboard Table
  console.log('┌──────┬─────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬────────┬────────┐');
  console.log('│ Rank │ Policy ID       │ Gen      │ TrainFit │ HeldOut  │ Survival │ AvgTicks │ ResGath│ Craft  │');
  console.log('├──────┼─────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼────────┼────────┤');

  for (const item of leaderboard) {
    const rankStr = String(item.rank).padStart(4);
    const idStr = String(item.policyId).slice(0, 15).padEnd(15);
    const genStr = String(item.generation).padStart(8);
    const trainFitStr = String(item.trainingFitness).padStart(8);
    const heldOutStr = String(item.heldOutFitness).padStart(8);
    const survStr = String(item.survivalRate).padStart(8);
    const ticksStr = String(item.avgTicks).padStart(8);
    const resStr = String(item.resourcesGathered).padStart(6);
    const craftStr = String(item.craftedItems).padStart(6);

    console.log(`│ ${rankStr} │ ${idStr} │ ${genStr} │ ${trainFitStr} │ ${heldOutStr} │ ${survStr} │ ${ticksStr} │ ${resStr} │ ${craftStr} │`);
  }
  console.log('└──────┴─────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴────────┴────────┘\n');

  // Save Collective Top 20 Manifest
  const manifestPayload = {
    selectedAt: new Date().toISOString(),
    generation,
    checkpointSource: checkpointPath,
    totalSelected: leaderboard.length,
    validationSeeds: options.heldOutSeeds,
    topPolicies: leaderboard
  };

  const latestTopPath = path.join(topPoliciesDir, 'top20-latest.json');
  const genTopPath = path.join(topPoliciesDir, `gen-${generation}-top20.json`);

  fs.writeFileSync(latestTopPath, JSON.stringify(manifestPayload, null, 2), 'utf-8');
  fs.writeFileSync(genTopPath, JSON.stringify(manifestPayload, null, 2), 'utf-8');

  console.log(`[Success] Top ${selectCount} policies saved to:`);
  console.log(` - ${latestTopPath}`);
  console.log(` - ${genTopPath}`);
  console.log(` - ${topPoliciesDir}/rank-*.json\n`);

  return leaderboard;
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  selectTopPolicies().catch(err => {
    console.error('[Error selecting top policies]:', err);
    process.exit(1);
  });
}
