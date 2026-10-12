import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  formatProgressLine,
  runThroughputBenchmark,
  main
} from '../src/evolution/index.js';

describe('Evolution CLI', () => {
  test('parses default CLI arguments correctly', () => {
    const opts = parseArgs([]);
    assert.equal(opts.generations, 100);
    assert.equal(opts.population, 50);
    assert.equal(opts.episodes, 3);
    assert.equal(opts.ticks, 2400);
    assert.equal(opts.seed, 42);
    assert.equal(opts.checkpoint, 10);
    assert.equal(opts.benchmark, false);
    assert.equal(opts.heldOut, false);
    assert.equal(opts.resume, null);
  });

  test('parses custom flags and options', () => {
    const opts = parseArgs([
      '--generations', '25',
      '--population', '30',
      '--episodes', '5',
      '--ticks', '1200',
      '--seed', '999',
      '--checkpoint', '5',
      '--benchmark',
      '--verbose',
      '--max-time', '15',
      '--held-out'
    ]);

    assert.equal(opts.generations, 25);
    assert.equal(opts.population, 30);
    assert.equal(opts.episodes, 5);
    assert.equal(opts.ticks, 1200);
    assert.equal(opts.seed, 999);
    assert.equal(opts.checkpoint, 5);
    assert.equal(opts.benchmark, true);
    assert.equal(opts.verbose, true);
    assert.equal(opts.maxTime, 15);
    assert.equal(opts.heldOut, true);
  });

  test('formats progress line accurately matching requested pattern', () => {
    const line = formatProgressLine({
      gen: 1,
      totalGenerations: 100,
      bestFitness: 1234.5,
      avgFitness: 567.8,
      baselineImprovement: 45.2,
      vDays: 14400,
      totalEpisodes: 150,
      epsPerSec: 2345,
      durationSec: 1.2
    });

    assert.equal(
      line,
      '[Gen 001/100] Best: 1234.5 | Avg: 567.8 | Baseline: +45.2% | VDays: 14400 | Eps: 150 | 2345 eps/s | 1.2s'
    );
  });

  test('runs throughput benchmark successfully', async () => {
    const bench = await runThroughputBenchmark({ episodes: 20, ticks: 100 });
    assert.ok(bench.episodesPerSecond > 0);
    assert.ok(bench.avgEpisodeMs >= 0);
    assert.ok(bench.totalMs >= 0);
  });

  test('runs mini evolution experiment through main()', async () => {
    const result = await main({
      generations: 2,
      population: 5,
      episodes: 1,
      ticks: 100,
      seed: 42,
      checkpoint: 1,
      benchmark: false,
      verbose: false,
      maxTime: null,
      heldOut: false
    });

    assert.ok(result);
    assert.ok(result.engine);
    assert.equal(result.reports.length, 2);
    assert.ok(result.summary);
    assert.ok(result.summary.bestFitness !== undefined);
  });
});
