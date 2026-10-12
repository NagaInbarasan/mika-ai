#!/usr/bin/env node
/**
 * CLI Entry Point for Accelerated Headless Artificial-Life Evolution Simulator
 * E:\MIKA\src\evolution\index.js
 *
 * Runs high-throughput genetic algorithm experiments on Minecraft-like survival policies,
 * benchmarks headless simulation throughput, tracks generational progress, and saves
 * checkpoints and best evolved policies to data/evolution/.
 *
 * Usage:
 *   node src/evolution/index.js [options]
 *     --generations N     Number of generations (default: 100)
 *     --population N      Population size (default: 50)
 *     --episodes N        Eval episodes per policy (default: 3)
 *     --ticks N           Max ticks per episode (default: 2400)
 *     --seed N            Base random seed (default: 42)
 *     --checkpoint N      Checkpoint every N generations (default: 10)
 *     --resume PATH       Resume from checkpoint file
 *     --benchmark         Run throughput benchmark only
 *     --verbose           Verbose output
 *     --max-time MINS     Maximum wall-clock minutes
 *     --held-out          Run held-out evaluation only on best policy
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { EvolutionEngine, EvolutionConfig, FitnessCalculator } from './evolution.js';
import { ParallelRunner, ExperienceStore, VirtualTimeTracker } from './runner.js';
import { Policy, extractFeatures } from './policy.js';
import { SimWorld, WorldConfig, SeededRandom } from './world.js';

/**
 * Parses command-line arguments into a structured options object.
 *
 * @param {string[]} args - Process argv slice
 * @returns {object} Parsed options
 */
export function parseArgs(args = process.argv.slice(2)) {
  const options = {
    generations: 100,
    population: 50,
    episodes: 3,
    ticks: 2400,
    seed: 42,
    checkpoint: 10,
    resume: null,
    benchmark: false,
    verbose: false,
    maxTime: null,
    heldOut: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--benchmark') {
      options.benchmark = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--held-out' || arg === '--heldout') {
      options.heldOut = true;
    } else if (arg === '--generations' || arg === '-g') {
      options.generations = parseInt(args[++i], 10);
    } else if (arg.startsWith('--generations=')) {
      options.generations = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--population' || arg === '-p') {
      options.population = parseInt(args[++i], 10);
    } else if (arg.startsWith('--population=')) {
      options.population = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--episodes' || arg === '-e') {
      options.episodes = parseInt(args[++i], 10);
    } else if (arg.startsWith('--episodes=')) {
      options.episodes = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--ticks' || arg === '-t') {
      options.ticks = parseInt(args[++i], 10);
    } else if (arg.startsWith('--ticks=')) {
      options.ticks = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--seed' || arg === '-s') {
      options.seed = parseInt(args[++i], 10);
    } else if (arg.startsWith('--seed=')) {
      options.seed = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--checkpoint' || arg === '-c') {
      options.checkpoint = parseInt(args[++i], 10);
    } else if (arg.startsWith('--checkpoint=')) {
      options.checkpoint = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--resume' || arg === '-r') {
      options.resume = args[++i];
    } else if (arg.startsWith('--resume=')) {
      options.resume = arg.split('=')[1];
    } else if (arg === '--max-time' || arg === '-m') {
      options.maxTime = parseFloat(args[++i]);
    } else if (arg.startsWith('--max-time=')) {
      options.maxTime = parseFloat(arg.split('=')[1]);
    }
  }

  // Sanitize numeric constraints
  if (isNaN(options.generations) || options.generations <= 0) options.generations = 100;
  if (isNaN(options.population) || options.population <= 0) options.population = 50;
  if (isNaN(options.episodes) || options.episodes <= 0) options.episodes = 3;
  if (isNaN(options.ticks) || options.ticks <= 0) options.ticks = 2400;
  if (isNaN(options.seed)) options.seed = 42;
  if (isNaN(options.checkpoint) || options.checkpoint <= 0) options.checkpoint = 10;
  if (options.maxTime !== null && (isNaN(options.maxTime) || options.maxTime <= 0)) {
    options.maxTime = null;
  }

  return options;
}

/**
 * Prints the welcome header banner.
 *
 * @param {object} config - Configuration parameters
 */
export function printBanner(config) {
  const vDays = (config.ticks / 1200).toFixed(1).replace(/\.0$/, '');
  const dayStr = `${config.ticks} (${vDays} virtual day${vDays === '1' ? '' : 's'})`;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     MIKA ACCELERATED EVOLUTION SIMULATOR                    ║');
  console.log('║     Headless Artificial-Life Survival Engine                 ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Population    : ${String(`${config.population} policies`).padEnd(43)}║`);
  console.log(`║  Generations   : ${String(config.generations).padEnd(43)}║`);
  console.log(`║  Episodes/Eval : ${String(`${config.episodes} per policy`).padEnd(43)}║`);
  console.log(`║  Ticks/Episode : ${String(dayStr).padEnd(43)}║`);
  console.log(`║  Base Seed     : ${String(config.seed).padEnd(43)}║`);
  console.log(`║  Checkpoint    : ${String(`Every ${config.checkpoint} generations`).padEnd(43)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
}

/**
 * Measures headless simulation throughput and returns benchmark statistics.
 *
 * @param {object} [options={}]
 * @param {number} [options.episodes=100]
 * @param {number} [options.ticks=600]
 * @returns {Promise<{ episodesPerSecond: number, avgEpisodeMs: number, totalMs: number }>}
 */
export async function runThroughputBenchmark(options = {}) {
  const episodeCount = options.episodes || 100;
  const maxTicks = options.ticks || 600;

  const runner = new ParallelRunner();
  const result = await runner.measureThroughput({
    episodes: episodeCount,
    worldConfig: { maxTicks }
  });

  return result;
}

/**
 * Formats compact generational progress line.
 * Format: [Gen 001/100] Best: 1234.5 | Avg: 567.8 | Baseline: +45.2% | VDays: 14400 | Eps: 150 | 2345 eps/s | 1.2s
 *
 * @param {object} params
 * @returns {string} Formatted line
 */
export function formatProgressLine(params) {
  const {
    gen,
    totalGenerations,
    bestFitness,
    avgFitness,
    baselineImprovement,
    vDays,
    totalEpisodes,
    epsPerSec,
    durationSec
  } = params;

  const genStr = `[Gen ${String(gen).padStart(3, '0')}/${totalGenerations}]`;
  const bestStr = `Best: ${Number(bestFitness).toFixed(1)}`;
  const avgStr = `Avg: ${Number(avgFitness).toFixed(1)}`;
  const sign = baselineImprovement >= 0 ? '+' : '';
  const baseStr = `Baseline: ${sign}${Number(baselineImprovement).toFixed(1)}%`;
  const vDaysStr = `VDays: ${Math.round(vDays)}`;
  const epsStr = `Eps: ${totalEpisodes}`;
  const rateStr = `${Math.round(epsPerSec)} eps/s`;
  const timeStr = `${Number(durationSec).toFixed(1)}s`;

  return `${genStr} ${bestStr} | ${avgStr} | ${baseStr} | ${vDaysStr} | ${epsStr} | ${rateStr} | ${timeStr}`;
}

/**
 * Prints a detailed summary block for a given generation.
 *
 * @param {object} report - Generational report
 * @param {object} engine - EvolutionEngine instance
 * @param {number} totalGenerations
 */
export function printDetailedSummary(report, engine, totalGenerations) {
  console.log('\n--------------------------------------------------------------------------------');
  console.log(`  Generation ${report.generation}/${totalGenerations} Detailed Summary:`);
  console.log(`    Best Fitness             : ${Number(report.bestFitness).toFixed(2)}`);
  console.log(`    Average Fitness          : ${Number(report.avgFitness).toFixed(2)}`);
  console.log(`    Worst Fitness            : ${Number(report.worstFitness).toFixed(2)}`);
  console.log(`    Population Diversity     : ${Number(report.populationDiversity).toFixed(2)}`);
  if (report.baselineFitness) {
    const h = report.baselineFitness.heuristic != null ? Number(report.baselineFitness.heuristic).toFixed(2) : 'N/A';
    const r = report.baselineFitness.random != null ? Number(report.baselineFitness.random).toFixed(2) : 'N/A';
    console.log(`    Heuristic Baseline       : ${h}`);
    console.log(`    Random Baseline          : ${r}`);
  }
  const sign = report.improvementOverBaseline >= 0 ? '+' : '';
  console.log(`    Improvement vs Baseline  : ${sign}${Number(report.improvementOverBaseline).toFixed(1)}%`);
  if (report.heldOutFitness != null) {
    console.log(`    Held-Out Evaluation      : ${Number(report.heldOutFitness).toFixed(2)}`);
  }
  if (report.bestPolicyId) {
    console.log(`    Best Policy ID           : ${report.bestPolicyId}`);
  }
  console.log('--------------------------------------------------------------------------------\n');
}

/**
 * Prints the final experiment summary box.
 *
 * @param {object} summary
 */
export function printFinalSummary(summary) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║               EVOLUTION EXPERIMENT SUMMARY                   ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Total Generations : ${String(summary.totalGenerations).padEnd(41)}║`);
  console.log(`║ Total Episodes    : ${String(summary.totalEpisodes.toLocaleString()).padEnd(41)}║`);
  console.log(`║ Virtual Time      : ${String(`${summary.virtualDays.toLocaleString()} days (${summary.virtualYears} years)`).padEnd(41)}║`);
  console.log(`║ Best Fitness      : ${String(Number(summary.bestFitness).toFixed(2)).padEnd(41)}║`);
  if (summary.baselineFitness) {
    console.log(`║ Heuristic Baseline: ${String(Number(summary.baselineFitness.heuristic || 0).toFixed(2)).padEnd(41)}║`);
    console.log(`║ Random Baseline   : ${String(Number(summary.baselineFitness.random || 0).toFixed(2)).padEnd(41)}║`);
  }
  const sign = summary.improvement >= 0 ? '+' : '';
  console.log(`║ Improvement       : ${String(`${sign}${Number(summary.improvement).toFixed(1)}%`).padEnd(41)}║`);
  if (summary.heldOutFitness != null) {
    console.log(`║ Held-Out Fitness  : ${String(Number(summary.heldOutFitness).toFixed(2)).padEnd(41)}║`);
  }
  console.log(`║ Overall Throughput: ${String(`${Math.round(summary.episodesPerSecond).toLocaleString()} eps/s`).padEnd(41)}║`);
  console.log(`║ Total Wall-Clock  : ${String(`${(summary.totalWallClockMs / 1000).toFixed(1)}s`).padEnd(41)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
}

/**
 * Main execution function orchestrating evolution experiments.
 *
 * @param {object} [cliOptions] - Options override (defaults to parsed process.argv)
 * @returns {Promise<object>} Complete experiment results
 */
export async function main(cliOptions = null) {
  const options = cliOptions || parseArgs();
  const store = new ExperienceStore();

  // 1. Print Banner
  printBanner(options);

  // 2. Run Throughput Benchmark First
  console.log('[Benchmark] Measuring headless simulation throughput...');
  const benchStartTime = performance.now();
  const bench = await runThroughputBenchmark({ episodes: 100, ticks: Math.min(options.ticks, 1200) });
  console.log(`[Benchmark] Throughput: ${bench.episodesPerSecond.toLocaleString()} eps/s (${bench.avgEpisodeMs} ms/ep)\n`);

  // If benchmark flag only, stop here
  if (options.benchmark) {
    console.log('[Benchmark] Benchmark completed. Exiting.');
    return { benchmark: bench };
  }

  // 3. Initialize or Resume Experiment
  let engine;
  let startGen = 0;

  if (options.resume) {
    const resumePath = path.isAbsolute(options.resume)
      ? options.resume
      : path.resolve(process.cwd(), options.resume);

    console.log(`[Resume] Loading experiment checkpoint from: ${resumePath}`);
    const checkpointContent = await fs.promises.readFile(resumePath, 'utf-8');
    const checkpointData = JSON.parse(checkpointContent);
    const engineData = checkpointData.engineState || checkpointData;

    engine = EvolutionEngine.restore(engineData);
    startGen = engine.generation;
    console.log(`[Resume] Restored engine at generation ${startGen} with best fitness: ${Number(engine.bestEverFitness).toFixed(2)}\n`);
  } else {
    engine = new EvolutionEngine({
      populationSize: options.population,
      numEvalEpisodes: options.episodes,
      maxEpisodeTicks: options.ticks,
      eliteCount: Math.max(1, Math.floor(options.population * 0.1)),
      mutationRate: 0.1,
      crossoverRate: 0.3
    });
    engine.initPopulation(options.seed);
  }

  // 4. Handle Held-Out Evaluation Only
  if (options.heldOut) {
    console.log('[Held-Out] Running held-out evaluation on best policy...');
    const targetPolicy = engine.bestEverPolicy || engine.population[0];
    const heldOutResult = engine.evaluateHeldOut(targetPolicy);
    console.log(`[Held-Out] Best Policy ID: ${targetPolicy.id}`);
    console.log(`[Held-Out] Average Fitness: ${Number(heldOutResult.fitness).toFixed(2)}`);
    console.log(`[Held-Out] Episodes Evaluated: ${heldOutResult.episodes.length}`);
    return { heldOutResult };
  }

  // 5. Generational Evolution Loop
  const totalGenerations = options.generations;
  const targetEndGen = startGen + totalGenerations;

  let cumulativeVirtualTicks = 0;
  let cumulativeEpisodes = 0;
  const experimentStartWallTime = performance.now();
  const maxWallClockMs = options.maxTime ? options.maxTime * 60 * 1000 : Infinity;

  const generationReports = [];

  console.log(`Starting evolutionary search: ${totalGenerations} generations (Target: Gen ${targetEndGen})...\n`);

  for (let currentGen = startGen + 1; currentGen <= targetEndGen; currentGen++) {
    const genStartWallTime = performance.now();

    // Advance engine by one generation
    const report = engine.nextGeneration();
    generationReports.push(report);

    const genWallMs = performance.now() - genStartWallTime;
    const genWallSec = genWallMs / 1000;

    // Calculate simulated episodes and ticks in this generation
    const episodesInGen = options.population * options.episodes;
    cumulativeEpisodes += episodesInGen;

    // Estimate virtual ticks completed from population episodes
    let genTicks = 0;
    for (const individual of engine.population) {
      if (individual.lastEvaluation?.episodes) {
        for (const ep of individual.lastEvaluation.episodes) {
          genTicks += ep.metrics?.ticksSurvived || options.ticks;
        }
      }
    }
    if (genTicks === 0) genTicks = episodesInGen * options.ticks;
    cumulativeVirtualTicks += genTicks;

    const cumulativeVDays = cumulativeVirtualTicks / 1200;
    const epsPerSec = genWallSec > 0 ? (episodesInGen / genWallSec) : 0;

    // 6. Print Progress Line
    const progressLine = formatProgressLine({
      gen: currentGen,
      totalGenerations: targetEndGen,
      bestFitness: report.bestFitness,
      avgFitness: report.avgFitness,
      baselineImprovement: report.improvementOverBaseline,
      vDays: cumulativeVDays,
      totalEpisodes: cumulativeEpisodes,
      epsPerSec,
      durationSec: genWallSec
    });
    console.log(progressLine);

    // 7. Save generation log to generations.jsonl
    await store.saveGenerationLog({
      generation: currentGen,
      bestFitness: report.bestFitness,
      avgFitness: report.avgFitness,
      worstFitness: report.worstFitness,
      improvementOverBaseline: report.improvementOverBaseline,
      diversity: report.populationDiversity,
      cumulativeEpisodes,
      cumulativeVirtualTicks,
      wallClockMs: Math.round(genWallMs)
    });

    // 8. Detailed summary every 10 generations
    if (currentGen % 10 === 0 || currentGen === targetEndGen) {
      printDetailedSummary(report, engine, targetEndGen);
    }

    // 9. Checkpoint saving
    if (currentGen % options.checkpoint === 0 || currentGen === targetEndGen) {
      await store.saveCheckpoint(engine.checkpoint(), `gen-${currentGen}`);
      if (engine.bestEverPolicy) {
        await store.saveBestPolicy(engine.bestEverPolicy, report.bestFitness, currentGen);
      }
    }

    // 10. Check max-time limit
    const elapsedWallClock = performance.now() - experimentStartWallTime;
    if (elapsedWallClock >= maxWallClockMs) {
      console.warn(`\n[TimeLimit] Maximum wall-clock time reached (${options.maxTime} mins). Finalizing experiment.`);
      break;
    }
  }

  // 11. Final Held-Out Evaluation on Best Policy
  const bestPolicy = engine.bestEverPolicy || engine.population[0];
  let finalHeldOut = null;
  if (bestPolicy) {
    finalHeldOut = engine.evaluateHeldOut(bestPolicy);
  }

  // 12. Final Summary Compilation & Save
  const totalExperimentWallMs = performance.now() - experimentStartWallTime;
  const overallEpsPerSec = totalExperimentWallMs > 0
    ? (cumulativeEpisodes / (totalExperimentWallMs / 1000))
    : 0;

  const baselineRef = engine.baselineFitness?.heuristic || engine.baselineFitness?.random || 1;
  const overallImprovement = baselineRef !== 0
    ? ((engine.bestEverFitness - baselineRef) / Math.abs(baselineRef)) * 100
    : 0;

  const finalSummaryData = {
    totalGenerations: generationReports.length,
    totalEpisodes: cumulativeEpisodes,
    virtualDays: Math.round(cumulativeVirtualTicks / 1200),
    virtualYears: Number((cumulativeVirtualTicks / 1200 / 365).toFixed(2)),
    bestFitness: engine.bestEverFitness,
    baselineFitness: engine.baselineFitness,
    improvement: overallImprovement,
    heldOutFitness: finalHeldOut?.fitness ?? null,
    episodesPerSecond: overallEpsPerSec,
    totalWallClockMs: totalExperimentWallMs,
    completedAt: new Date().toISOString()
  };

  printFinalSummary(finalSummaryData);

  // Save experiment summary
  await store.saveExperimentSummary(finalSummaryData);

  return {
    engine,
    summary: finalSummaryData,
    reports: generationReports,
    bestPolicy
  };
}

// Auto-run if executed directly as script
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('src/evolution/index.js') ||
  process.argv[1].endsWith('src\\evolution\\index.js') ||
  process.argv[1] === fileURLToPath(import.meta.url)
);

if (isMainModule) {
  main().catch((err) => {
    console.error('[Error] Fatal evolution CLI error:', err);
    process.exit(1);
  });
}
