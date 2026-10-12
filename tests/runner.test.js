import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ParallelRunner,
  ExperienceStore,
  VirtualTimeTracker,
  resolvePolicyAction,
  calculateEpisodeFitness,
  runConcurrentPool,
  DefaultEvolutionEngine
} from '../src/evolution/runner.js';
import { ACTIONS, WorldConfig } from '../src/evolution/world.js';

const TEST_DATA_DIR = path.resolve('data', 'test_evolution');

describe('ExperienceStore', () => {
  before(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  after(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  test('initializes and creates directories on demand', () => {
    const store = new ExperienceStore({ dataDir: TEST_DATA_DIR });
    assert.ok(fs.existsSync(TEST_DATA_DIR));
    assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'checkpoints')));
    assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, 'best-policies')));
  });

  test('saves and loads engine checkpoints correctly', async () => {
    const store = new ExperienceStore({ dataDir: TEST_DATA_DIR });
    const mockEngine = {
      generation: 5,
      bestFitness: 142.5,
      populationSize: 10,
      toJSON() {
        return { generation: this.generation, bestFitness: this.bestFitness, populationSize: this.populationSize };
      }
    };

    const savedPath = await store.saveCheckpoint(mockEngine, 'gen-5');
    assert.ok(fs.existsSync(savedPath));

    const loaded = await store.loadCheckpoint('gen-5');
    assert.equal(loaded.generation, 5);
    assert.equal(loaded.bestFitness, 142.5);

    const loadedWithFilename = await store.loadCheckpoint('checkpoint-gen-5.json');
    assert.equal(loadedWithFilename.generation, 5);

    const checkpoints = await store.listCheckpoints();
    assert.ok(checkpoints.includes('gen-5'));
  });

  test('logs generation reports in JSON lines format', async () => {
    const store = new ExperienceStore({ dataDir: TEST_DATA_DIR });
    const report1 = { generation: 1, bestFitness: 12.0, avgFitness: 8.5 };
    const report2 = { generation: 2, bestFitness: 25.0, avgFitness: 15.0 };

    await store.saveGenerationLog(report1);
    await store.saveGenerationLog(report2);

    const jsonlPath = path.join(TEST_DATA_DIR, 'generations.jsonl');
    assert.ok(fs.existsSync(jsonlPath));

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const parsed1 = JSON.parse(lines[0]);
    assert.equal(parsed1.generation, 1);
    assert.equal(parsed1.bestFitness, 12.0);

    const parsed2 = JSON.parse(lines[1]);
    assert.equal(parsed2.generation, 2);
    assert.equal(parsed2.bestFitness, 25.0);
  });

  test('saves best policy representation', async () => {
    const store = new ExperienceStore({ dataDir: TEST_DATA_DIR });
    const bestPolicy = {
      id: 'best_policy_gen_3',
      weights: { MOVE_NORTH: 0.9, GATHER: 0.8 }
    };

    const savedPath = await store.saveBestPolicy(bestPolicy, 88.5, 3);
    assert.ok(fs.existsSync(savedPath));

    const content = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
    assert.equal(content.generation, 3);
    assert.equal(content.fitness, 88.5);
    assert.equal(content.policy.id, 'best_policy_gen_3');
  });

  test('saves experiment summary report', async () => {
    const store = new ExperienceStore({ dataDir: TEST_DATA_DIR });
    const summary = {
      generationsCompleted: 10,
      finalBestFitness: 150.2,
      totalWallClockMs: 1200
    };

    const savedPath = await store.saveExperimentSummary(summary);
    assert.ok(fs.existsSync(savedPath));

    const loaded = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
    assert.equal(loaded.generationsCompleted, 10);
    assert.equal(loaded.finalBestFitness, 150.2);
    assert.ok(loaded.savedAt);
  });
});

describe('VirtualTimeTracker', () => {
  test('accurately tracks virtual ticks, days, and years', () => {
    const tracker = new VirtualTimeTracker({ ticksPerDay: 1200 });
    assert.equal(tracker.virtualTicksCompleted, 0);
    assert.equal(tracker.virtualDaysCompleted, 0);
    assert.equal(tracker.virtualYearsCompleted, 0);

    // 1 virtual day = 1200 ticks
    tracker.update(1200, 100);
    assert.equal(tracker.virtualTicksCompleted, 1200);
    assert.equal(tracker.virtualDaysCompleted, 1);
    assert.equal(tracker.episodesCompleted, 1);
    assert.equal(tracker.wallClockMs, 100);
    assert.equal(tracker.ticksPerSecond, 12000); // 1200 / 0.1s

    // 365 virtual days = 1 virtual year (438,000 ticks)
    tracker.update(438000 - 1200, 900);
    assert.equal(tracker.virtualDaysCompleted, 365);
    assert.equal(tracker.virtualYearsCompleted, 1);

    tracker.recordGeneration();
    tracker.recordGeneration();
    assert.equal(tracker.generationsCompleted, 2);

    const summary = tracker.getSummary();
    assert.equal(summary.virtualTicksCompleted, 438000);
    assert.equal(summary.virtualDaysCompleted, 365);
    assert.equal(summary.virtualYearsCompleted, 1);
    assert.equal(summary.episodesCompleted, 2);
    assert.equal(summary.generationsCompleted, 2);

    const progressStr = tracker.getProgressString();
    assert.ok(progressStr.includes('Episodes: 2'));
    assert.ok(progressStr.includes('Virtual: 365.0d (1.00y)'));
  });
});

describe('ParallelRunner', () => {
  const runnerTestDir = path.resolve('data', 'test_runner_evolution');

  before(() => {
    if (fs.existsSync(runnerTestDir)) {
      fs.rmSync(runnerTestDir, { recursive: true, force: true });
    }
  });

  after(() => {
    if (fs.existsSync(runnerTestDir)) {
      fs.rmSync(runnerTestDir, { recursive: true, force: true });
    }
  });

  test('caps maxConcurrent appropriately', () => {
    const runner = new ParallelRunner({ maxConcurrent: 32 });
    assert.equal(runner.maxConcurrent, 16);

    const runner2 = new ParallelRunner({ maxConcurrent: 4 });
    assert.equal(runner2.maxConcurrent, 4);
  });

  test('runs single episode and collects valid metrics', () => {
    const runner = new ParallelRunner({ maxConcurrent: 2 });
    const policy = () => ACTIONS.GATHER;
    const result = runner.runSingleEpisode(policy, 12345, { maxTicks: 20 });

    assert.equal(typeof result.ticks, 'number');
    assert.ok(result.ticks <= 20);
    assert.ok(result.metrics);
    assert.equal(typeof result.fitness, 'number');
    assert.equal(typeof result.durationMs, 'number');
  });

  test('runs episode batch concurrently with Promise pool', async () => {
    const runner = new ParallelRunner({ maxConcurrent: 4 });
    const policies = [
      () => ACTIONS.MOVE_NORTH,
      () => ACTIONS.MOVE_SOUTH,
      () => ACTIONS.MOVE_EAST,
      () => ACTIONS.GATHER
    ];
    const seeds = [101, 102, 103, 104];

    const results = await runner.runEpisodeBatch(policies, seeds, { maxTicks: 30 });
    assert.equal(results.length, 4);

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].seed, seeds[i]);
      assert.equal(results[i].policyIndex, i);
      assert.ok(results[i].ticks <= 30);
      assert.ok(typeof results[i].fitness === 'number');
      assert.ok(typeof results[i].durationMs === 'number');
    }
  });

  test('evaluates Cartesian product when seeds and policies lengths differ', async () => {
    const runner = new ParallelRunner({ maxConcurrent: 4 });
    const policies = [
      () => ACTIONS.MOVE_NORTH,
      () => ACTIONS.MOVE_SOUTH
    ];
    const seeds = [1001, 1002, 1003];

    // 2 policies * 3 seeds = 6 episodes
    const results = await runner.runEpisodeBatch(policies, seeds, { maxTicks: 15 });
    assert.equal(results.length, 6);
  });

  test('measures throughput benchmark', async () => {
    const runner = new ParallelRunner({ maxConcurrent: 8 });
    const res = await runner.measureThroughput({ episodes: 20, worldConfig: { maxTicks: 25 } });

    assert.equal(typeof res.episodesPerSecond, 'number');
    assert.ok(res.episodesPerSecond > 0);
    assert.equal(typeof res.avgEpisodeMs, 'number');
    assert.equal(typeof res.totalMs, 'number');
    assert.ok(res.totalMs > 0);
  });

  test('runs full evolution experiment with checkpoints and held-out evaluation', async () => {
    const store = new ExperienceStore({ dataDir: runnerTestDir });
    const runner = new ParallelRunner({ maxConcurrent: 4, experienceStore: store });

    const experimentResult = await runner.runEvolutionExperiment({
      generations: 3,
      populationSize: 4,
      seeds: [201, 202],
      checkpointInterval: 2,
      verbose: false,
      worldConfig: { maxTicks: 25 },
      heldOutSeeds: [901, 902]
    });

    assert.ok(experimentResult);
    assert.equal(experimentResult.generationReports.length, 3);
    assert.ok(experimentResult.bestPolicy);
    assert.ok(experimentResult.summary);
    assert.equal(experimentResult.summary.generationsCompleted, 3);
    assert.equal(experimentResult.heldOutResults.length, 2);

    // Verify checkpoints were created
    const checkpoints = await store.listCheckpoints();
    assert.ok(checkpoints.includes('gen-2'));
    assert.ok(checkpoints.includes('gen-3'));

    // Verify summary and generation log exist on disk
    assert.ok(fs.existsSync(path.join(runnerTestDir, 'experiment-summary.json')));
    assert.ok(fs.existsSync(path.join(runnerTestDir, 'generations.jsonl')));
    assert.ok(fs.existsSync(path.join(runnerTestDir, 'best-policies', 'gen-1.json')));
  });

  test('respects maxWallClockMs timeout during experiment', async () => {
    const store = new ExperienceStore({ dataDir: runnerTestDir });
    const runner = new ParallelRunner({ maxConcurrent: 2, experienceStore: store });

    const experimentResult = await runner.runEvolutionExperiment({
      generations: 50,
      populationSize: 8,
      seeds: [301, 302],
      maxWallClockMs: 15, // Immediate timeout
      verbose: false,
      worldConfig: { maxTicks: 50 }
    });

    // Should break early before reaching 50 generations
    assert.ok(experimentResult.generationReports.length < 50);
  });
});
