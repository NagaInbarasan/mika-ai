#!/usr/bin/env node
/**
 * Accelerated Artificial-Life Evolution Simulator: Million-Year Survival Engine
 * E:\MIKA\src\evolution\million-years.js
 *
 * Runs high-throughput genetic survival simulations targeting millions of virtual
 * years across large populations (e.g. 500 parallel policies).
 *
 * Distinguishes precisely:
 *  - Virtual days & years simulated
 *  - Number of episodes completed
 *  - Number of generations evaluated
 *  - Actual wall-clock runtime
 *  - Measured learning progress
 *
 * Usage:
 *   node src/evolution/million-years.js [options]
 *     --population N      Population size (default: 500)
 *     --generations N     Generations to run (default: 500)
 *     --target-years N    Target virtual years (default: 1,000,000)
 *     --time-step N       Ticks per decision step (default: 1200, i.e. 1 virtual day/step)
 *     --episodes N        Evaluation episodes per policy (default: 2)
 *     --steps N           Max decision steps per episode (default: 365, i.e. 1 virtual year/episode)
 *     --checkpoint N      Save checkpoint every N generations (default: 50)
 *     --seed N            Base deterministic seed (default: 42)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { EvolutionEngine, EvolutionConfig, FitnessCalculator } from './evolution.js';
import { Policy } from './policy.js';
import { SimWorld, WorldConfig, SeededRandom } from './world.js';
import { ExperienceStore, VirtualTimeTracker } from './runner.js';
import { selectTopPolicies } from './select-top.js';

export function parseMillionYearArgs(args = process.argv.slice(2)) {
  const options = {
    population: 500,
    generations: 500,
    targetYears: 1000000,
    timeStep: 1200,      // 1200 ticks = 1 virtual day per step
    ticksPerDay: 1200,
    daysPerYear: 365,
    episodes: 2,
    steps: 365,          // 365 days = 1 virtual year per episode
    checkpoint: 50,
    seed: 42,
    eliteCount: 20       // Preserves top 20 policies by default
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--population' || arg === '-p') {
      options.population = parseInt(args[++i], 10);
    } else if (arg.startsWith('--population=')) {
      options.population = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--generations' || arg === '-g') {
      options.generations = parseInt(args[++i], 10);
    } else if (arg.startsWith('--generations=')) {
      options.generations = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--target-years' || arg === '-y') {
      options.targetYears = parseFloat(args[++i]);
    } else if (arg.startsWith('--target-years=')) {
      options.targetYears = parseFloat(arg.split('=')[1]);
    } else if (arg === '--time-step' || arg === '-ts') {
      options.timeStep = parseInt(args[++i], 10);
    } else if (arg.startsWith('--time-step=')) {
      options.timeStep = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--episodes' || arg === '-e') {
      options.episodes = parseInt(args[++i], 10);
    } else if (arg.startsWith('--episodes=')) {
      options.episodes = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--steps' || arg === '-s') {
      options.steps = parseInt(args[++i], 10);
    } else if (arg.startsWith('--steps=')) {
      options.steps = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--checkpoint' || arg === '-c') {
      options.checkpoint = parseInt(args[++i], 10);
    } else if (arg.startsWith('--checkpoint=')) {
      options.checkpoint = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--seed') {
      options.seed = parseInt(args[++i], 10);
    } else if (arg.startsWith('--seed=')) {
      options.seed = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--elites' || arg === '-k') {
      options.eliteCount = parseInt(args[++i], 10);
    }
  }

  return options;
}

export async function runMillionYearEvolution(customOptions = null) {
  const options = customOptions || parseMillionYearArgs();
  const ticksPerEpisode = options.steps * options.timeStep;
  const virtualYearsPerEpisode = (ticksPerEpisode / options.ticksPerDay) / options.daysPerYear;
  const virtualYearsPerGen = options.population * options.episodes * virtualYearsPerEpisode;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     MIKA ACCELERATED MILLION-YEAR EVOLUTION SIMULATOR        ║');
  console.log('║     High-Throughput Artificial-Life Survival Engine          ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Population Size : ${String(`${options.population} parallel policies`).padEnd(42)}║`);
  console.log(`║  Elite Selection : Top ${String(`${options.eliteCount} policies preserved`).padEnd(39)}║`);
  console.log(`║  Time Step (dt)  : ${String(`${options.timeStep} ticks/step (1 day/step)`).padEnd(42)}║`);
  console.log(`║  Episode Length  : ${String(`${options.steps} steps (${virtualYearsPerEpisode.toFixed(1)} virtual years)`).padEnd(42)}║`);
  console.log(`║  Virtual Time/Gen: ${String(`${Math.round(virtualYearsPerGen).toLocaleString()} virtual years/generation`).padEnd(42)}║`);
  console.log(`║  Target Years    : ${String(`${options.targetYears.toLocaleString()} virtual years`).padEnd(42)}║`);
  console.log(`║  Total Gens Goal : ${String(`${options.generations} generations`).padEnd(42)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const store = new ExperienceStore();
  const timeTracker = new VirtualTimeTracker({ ticksPerDay: options.ticksPerDay });

  // Initialize Evolution Engine with large population
  const engine = new EvolutionEngine({
    populationSize: options.population,
    numEvalEpisodes: options.episodes,
    maxEpisodeTicks: ticksPerEpisode,
    eliteCount: options.eliteCount,
    mutationRate: 0.12,
    crossoverRate: 0.35,
    tournamentSize: 7
  });

  console.log(`[Init] Spawning initial population of ${options.population} survival policies...`);
  engine.initPopulation(options.seed);
  console.log(`[Init] Population initialized with seed ${options.seed}.\n`);

  let cumulativeVirtualTicks = 0;
  let cumulativeEpisodes = 0;
  let cumulativeVirtualYears = 0;
  const startTime = performance.now();

  console.log('Starting accelerated multi-agent evolution across deep virtual time...\n');

  for (let gen = 1; gen <= options.generations; gen++) {
    const genStart = performance.now();

    // Advance generation
    const report = engine.nextGeneration();

    const genWallMs = performance.now() - genStart;
    const genWallSec = genWallMs / 1000;

    const episodesInGen = options.population * options.episodes;
    const ticksInGen = episodesInGen * ticksPerEpisode;
    const yearsInGen = (ticksInGen / options.ticksPerDay) / options.daysPerYear;

    cumulativeEpisodes += episodesInGen;
    cumulativeVirtualTicks += ticksInGen;
    cumulativeVirtualYears += yearsInGen;

    timeTracker.update(ticksInGen, genWallMs);
    timeTracker.recordGeneration();

    const epsPerSec = genWallSec > 0 ? (episodesInGen / genWallSec) : 0;
    const elapsedSec = (performance.now() - startTime) / 1000;

    // Progress Line
    const vYearsStr = Math.round(cumulativeVirtualYears).toLocaleString();
    const bestFitStr = (report.bestFitness || 0).toFixed(1);
    const avgFitStr = (report.avgFitness || 0).toFixed(1);
    const genStr = String(gen).padStart(String(options.generations).length, '0');
    
    console.log(
      `[Gen ${genStr}/${options.generations}] Best: ${bestFitStr} | Avg: ${avgFitStr} | ` +
      `VYears: ${vYearsStr}y | Eps: ${cumulativeEpisodes.toLocaleString()} | ` +
      `${Math.round(epsPerSec).toLocaleString()} eps/s | ${genWallSec.toFixed(1)}s (Total: ${elapsedSec.toFixed(0)}s)`
    );

    // Save periodic checkpoint & top policies
    if (gen % options.checkpoint === 0 || gen === options.generations || cumulativeVirtualYears >= options.targetYears) {
      console.log(`\n--- Checkpoint & Top 20 Selection at Generation ${gen} (${vYearsStr} Virtual Years) ---`);
      const ckptPath = await store.saveCheckpoint(engine.checkpoint(), `gen-${gen}`);
      if (engine.bestEverPolicy) {
        await store.saveBestPolicy(engine.bestEverPolicy, report.bestFitness, gen);
      }
      // Run Top 20 selection on this checkpoint
      try {
        await selectTopPolicies({
          top: options.eliteCount,
          checkpoint: ckptPath,
          ticks: Math.min(ticksPerEpisode, 2400)
        });
      } catch (selErr) {
        console.warn(`[Warning] Could not extract top 20: ${selErr.message}`);
      }
      console.log('--------------------------------------------------------------------------------\n');
    }

    // Check if target virtual years achieved
    if (cumulativeVirtualYears >= options.targetYears) {
      console.log(`\n🎉 TARGET ACHIEVED: Completed ${Math.round(cumulativeVirtualYears).toLocaleString()} Virtual Years!`);
      break;
    }
  }

  const totalWallMs = performance.now() - startTime;
  const totalWallSec = totalWallMs / 1000;
  const overallThroughput = totalWallSec > 0 ? (cumulativeEpisodes / totalWallSec) : 0;

  // Final Summary Report
  const finalSummary = {
    experimentName: 'Accelerated Million-Year Evolution',
    completedAt: new Date().toISOString(),
    populationSize: options.population,
    totalGenerations: engine.generation,
    totalEpisodes: cumulativeEpisodes,
    virtualDays: Math.round(cumulativeVirtualTicks / options.ticksPerDay),
    virtualYears: Math.round(cumulativeVirtualYears),
    bestEverFitness: engine.bestEverFitness,
    overallThroughputEpsPerSec: Math.round(overallThroughput),
    wallClockDurationSec: Number(totalWallSec.toFixed(1))
  };

  const summaryPath = path.resolve(process.cwd(), 'data', 'evolution', 'million-years-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(finalSummary, null, 2), 'utf-8');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║           MILLION-YEAR EXPERIMENT FINAL RESULTS              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Total Generations : ${String(finalSummary.totalGenerations).padEnd(41)}║`);
  console.log(`║ Total Episodes    : ${String(finalSummary.totalEpisodes.toLocaleString()).padEnd(41)}║`);
  console.log(`║ Virtual Time      : ${String(`${finalSummary.virtualYears.toLocaleString()} YEARS (${finalSummary.virtualDays.toLocaleString()} days)`).padEnd(41)}║`);
  console.log(`║ Best Fitness      : ${String(Number(finalSummary.bestEverFitness).toFixed(2)).padEnd(41)}║`);
  console.log(`║ Throughput        : ${String(`${finalSummary.overallThroughputEpsPerSec.toLocaleString()} eps/s`).padEnd(41)}║`);
  console.log(`║ Wall-Clock Time   : ${String(`${finalSummary.wallClockDurationSec}s (${(finalSummary.wallClockDurationSec/60).toFixed(1)} mins)`).padEnd(41)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  return finalSummary;
}

// CLI Execution entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMillionYearEvolution().catch(err => {
    console.error('[Fatal Error in Million-Year Evolution]:', err);
    process.exit(1);
  });
}
