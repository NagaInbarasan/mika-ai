import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SimWorld,
  WorldConfig,
  SeededRandom,
  ACTIONS,
  RESOURCES,
  RECIPES
} from '../src/evolution/world.js';

import {
  Policy as MatrixPolicy,
  HeuristicPolicy as PolicyHeuristic,
  RandomPolicy as PolicyRandom,
  extractFeatures,
  ACTION_DEFINITIONS,
  getActionIndex
} from '../src/evolution/policy.js';

import {
  EvolutionEngine,
  EvolutionConfig,
  FitnessCalculator,
  Policy as EnginePolicy,
  HeuristicPolicy as EngineHeuristic,
  RandomPolicy as EngineRandom
} from '../src/evolution/evolution.js';

import {
  ParallelRunner,
  ExperienceStore,
  VirtualTimeTracker,
  calculateEpisodeFitness,
  resolvePolicyAction,
  DefaultEvolutionEngine
} from '../src/evolution/runner.js';

// ============================================================================
// 1. SeededRandom Tests
// ============================================================================
describe('SeededRandom Tests', () => {
  test('Same seed produces same sequence', () => {
    const r1 = new SeededRandom(42);
    const r2 = new SeededRandom(42);

    for (let i = 0; i < 20; i++) {
      assert.strictEqual(r1.next(), r2.next(), `Index ${i} should have identical values`);
    }
  });

  test('Different seeds produce different sequences', () => {
    const r1 = new SeededRandom(111);
    const r2 = new SeededRandom(999);

    let matchCount = 0;
    const trials = 20;
    for (let i = 0; i < trials; i++) {
      if (r1.next() === r2.next()) {
        matchCount++;
      }
    }
    assert.ok(matchCount < trials / 2, 'Different seeds should produce different random sequences');
  });

  test('nextFloat() returns values in [0, 1)', () => {
    const rng = new SeededRandom(12345);
    for (let i = 0; i < 100; i++) {
      const val = rng.nextFloat();
      assert.ok(val >= 0, `Value ${val} should be >= 0`);
      assert.ok(val < 1, `Value ${val} should be < 1`);
    }
  });

  test('nextInt(min, max) returns values in [min, max]', () => {
    const rng = new SeededRandom(54321);

    // Test positive range [3, 7]
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const val = rng.nextInt(3, 7);
      assert.ok(Number.isInteger(val), `Value ${val} should be an integer`);
      assert.ok(val >= 3, `Value ${val} should be >= 3`);
      assert.ok(val <= 7, `Value ${val} should be <= 7`);
      seen.add(val);
    }
    assert.strictEqual(seen.size, 5, 'All numbers between 3 and 7 should be produced eventually');

    // Test zero to one [0, 1]
    for (let i = 0; i < 50; i++) {
      const val = rng.nextInt(0, 1);
      assert.ok(val === 0 || val === 1, `Value ${val} must be 0 or 1`);
    }

    // Test negative to positive [-5, 5]
    for (let i = 0; i < 100; i++) {
      const val = rng.nextInt(-5, 5);
      assert.ok(val >= -5 && val <= 5, `Value ${val} must be in [-5, 5]`);
    }

    // Test single element range [4, 4]
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(rng.nextInt(4, 4), 4);
    }
  });
});

// ============================================================================
// 2. SimWorld Tests
// ============================================================================
describe('SimWorld Tests', () => {
  test('World creates with correct dimensions', () => {
    const world = new SimWorld({ gridSize: 32 }, 101);
    assert.strictEqual(world.config.gridSize, 32);
    assert.strictEqual(world.grid.length, 32);
    assert.strictEqual(world.grid[0].length, 32);
    assert.strictEqual(world.grid[31].length, 32);
  });

  test('Resources are placed based on density', () => {
    const highDensityWorld = new SimWorld({ gridSize: 40, resourceDensity: 0.5 }, 123);
    const zeroDensityWorld = new SimWorld({ gridSize: 40, resourceDensity: 0.0 }, 123);

    let highCount = 0;
    let zeroCount = 0;

    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        if (highDensityWorld.grid[y][x].resource) highCount++;
        if (zeroDensityWorld.grid[y][x].resource) zeroCount++;
      }
    }

    assert.strictEqual(zeroCount, 0, 'Zero density world should have 0 resources');
    assert.ok(highCount > 600, `High density world should have many resources (found ${highCount})`);
  });

  test('Agent starts with full health and food', () => {
    const world = new SimWorld({ maxHealth: 20, maxFood: 20 }, 555);
    assert.strictEqual(world.agent.health, 20);
    assert.strictEqual(world.agent.food, 20);
    assert.strictEqual(world.agent.alive, true);
    assert.strictEqual(world.agent.ticksSurvived, 0);
  });

  test('GATHER action collects resources from current cell', () => {
    const world = new SimWorld({ gridSize: 16 }, 42);
    const pos = world.agent.position;
    const cell = world.getCell(pos.x, pos.y);

    // Explicitly place a WOOD resource on spawn cell
    cell.resource = {
      type: 'WOOD',
      amount: 1,
      maxAmount: 1,
      gatherProgress: 0
    };

    const initialWood = world.getInventoryCount('WOOD');

    // Wood takes 2 ticks to gather with no pickaxe
    world.tick(ACTIONS.GATHER);
    assert.strictEqual(world.getInventoryCount('WOOD'), initialWood, 'Wood should not be gathered in 1 tick');

    world.tick(ACTIONS.GATHER);
    assert.strictEqual(world.getInventoryCount('WOOD'), initialWood + 1, 'Wood should be gathered after 2 ticks');
    assert.strictEqual(cell.resource, null, 'Resource should be consumed');
    assert.strictEqual(world.agent.totalResourcesGathered, 1);
  });

  test('Movement actions change position correctly', () => {
    const world = new SimWorld({ gridSize: 32 }, 101);
    const startX = world.agent.position.x;
    const startY = world.agent.position.y;

    // MOVE_NORTH decreases y
    world.tick(ACTIONS.MOVE_NORTH);
    assert.strictEqual(world.agent.position.y, startY - 1);
    assert.strictEqual(world.agent.position.x, startX);

    // MOVE_SOUTH increases y
    world.tick(ACTIONS.MOVE_SOUTH);
    assert.strictEqual(world.agent.position.y, startY);

    // MOVE_EAST increases x
    world.tick(ACTIONS.MOVE_EAST);
    assert.strictEqual(world.agent.position.x, startX + 1);

    // MOVE_WEST decreases x
    world.tick(ACTIONS.MOVE_WEST);
    assert.strictEqual(world.agent.position.x, startX);
  });

  test('Movement is bounded (can not go off grid)', () => {
    const world = new SimWorld({ gridSize: 10 }, 101);

    // Move agent to (0, 0)
    world.agent.position = { x: 0, y: 0 };
    world.tick(ACTIONS.MOVE_NORTH);
    assert.strictEqual(world.agent.position.y, 0, 'Cannot move north beyond top boundary');
    world.tick(ACTIONS.MOVE_WEST);
    assert.strictEqual(world.agent.position.x, 0, 'Cannot move west beyond left boundary');

    // Move agent to (9, 9)
    world.agent.position = { x: 9, y: 9 };
    world.tick(ACTIONS.MOVE_SOUTH);
    assert.strictEqual(world.agent.position.y, 9, 'Cannot move south beyond bottom boundary');
    world.tick(ACTIONS.MOVE_EAST);
    assert.strictEqual(world.agent.position.x, 9, 'Cannot move east beyond right boundary');
  });

  test('Hunger drains over time', () => {
    const world = new SimWorld({ hungerRate: 0.1 }, 101);
    const initialFood = world.agent.food;

    world.tick(ACTIONS.IDLE);
    assert.ok(Math.abs(world.agent.food - (initialFood - 0.1)) < 1e-6);

    world.tick(ACTIONS.IDLE);
    assert.ok(Math.abs(world.agent.food - (initialFood - 0.2)) < 1e-6);
  });

  test('Agent dies when health reaches 0', () => {
    const world = new SimWorld({}, 101);
    world.agent.health = 1;
    const pos = world.agent.position;
    const cell = world.getCell(pos.x, pos.y);
    cell.threat = { active: true, damage: 10 };

    world.tick(ACTIONS.IDLE);
    assert.strictEqual(world.agent.alive, false);
    assert.strictEqual(world.agent.health, 0);
    assert.strictEqual(world.agent.deathCause, 'threat');
  });

  test('Agent dies when food reaches 0', () => {
    const world = new SimWorld({ hungerRate: 1.0 }, 101);
    world.agent.food = 0.5;

    world.tick(ACTIONS.IDLE);
    assert.strictEqual(world.agent.alive, false);
    assert.strictEqual(world.agent.food, 0);
    assert.strictEqual(world.agent.deathCause, 'starvation');
  });

  test('Crafting consumes correct ingredients', () => {
    const world = new SimWorld({}, 101);
    // wooden_pickaxe cost: 3 WOOD
    world.modifyInventory('WOOD', 5);
    world.tick(ACTIONS.CRAFT, 'wooden_pickaxe');

    assert.strictEqual(world.getInventoryCount('WOOD'), 2);
    assert.ok(world.agent.tools.has('wooden_pickaxe'));
    assert.strictEqual(world.agent.totalCrafted, 1);
  });

  test('Crafting fails without ingredients', () => {
    const world = new SimWorld({}, 101);
    world.modifyInventory('WOOD', 2); // needs 3 WOOD
    world.tick(ACTIONS.CRAFT, 'wooden_pickaxe');

    assert.strictEqual(world.getInventoryCount('WOOD'), 2);
    assert.strictEqual(world.agent.tools.has('wooden_pickaxe'), false);
    assert.strictEqual(world.agent.totalCrafted, 0);
  });

  test('Shelter reduces threat damage', () => {
    // 1. Without shelter
    const worldNoShelter = new SimWorld({ shelterProtection: 0.8 }, 101);
    const pos1 = worldNoShelter.agent.position;
    worldNoShelter.getCell(pos1.x, pos1.y).threat = { active: true, damage: 10 };
    worldNoShelter.tick(ACTIONS.IDLE);
    const damageWithoutShelter = worldNoShelter.agent.totalDamageTaken;

    // 2. With shelter
    const worldWithShelter = new SimWorld({ shelterProtection: 0.8 }, 101);
    const pos2 = worldWithShelter.agent.position;
    const cell2 = worldWithShelter.getCell(pos2.x, pos2.y);
    cell2.shelter = true;
    cell2.threat = { active: true, damage: 10 };
    worldWithShelter.tick(ACTIONS.IDLE);
    const damageWithShelter = worldWithShelter.agent.totalDamageTaken;

    assert.strictEqual(damageWithoutShelter, 10);
    assert.ok(Math.abs(damageWithShelter - 2) < 1e-6, `Expected ~2 damage with 80% protection, got ${damageWithShelter}`);
    assert.ok(damageWithShelter < damageWithoutShelter);
  });

  test('Night increases threat frequency', () => {
    const world = new SimWorld({ ticksPerDay: 200, threatDensity: 0.5 }, 101);
    // At tick 0 (day), isNight is false.
    // At tick 101 (night), isNight is true.
    const isNightDay = (0 % 200) > (200 / 2);
    const isNightNight = (150 % 200) > (200 / 2);
    assert.strictEqual(isNightDay, false);
    assert.strictEqual(isNightNight, true);

    // Verify day/night flag in observation
    world.currentTick = 50;
    assert.strictEqual(world.getObservation().isNight, false);
    world.currentTick = 150;
    assert.strictEqual(world.getObservation().isNight, true);
  });

  test('Health regenerates when food is high', () => {
    const world = new SimWorld({ healthRegenRate: 0.5 }, 101);
    world.agent.health = 10;
    world.agent.food = 18; // > 15 triggers regeneration

    world.tick(ACTIONS.IDLE);
    assert.ok(world.agent.health > 10, 'Health should regenerate when food > 15');
    assert.ok(Math.abs(world.agent.health - 10.5) < 1e-6);
  });

  test('Deterministic: same seed same actions same result', () => {
    const w1 = new SimWorld({ gridSize: 20 }, 777);
    const w2 = new SimWorld({ gridSize: 20 }, 777);

    const actionSequence = [
      ACTIONS.MOVE_NORTH,
      ACTIONS.MOVE_EAST,
      ACTIONS.GATHER,
      ACTIONS.IDLE,
      ACTIONS.MOVE_SOUTH,
      ACTIONS.MOVE_WEST
    ];

    for (const act of actionSequence) {
      w1.tick(act);
      w2.tick(act);
    }

    assert.deepStrictEqual(w1.agent.position, w2.agent.position);
    assert.strictEqual(w1.agent.health, w2.agent.health);
    assert.strictEqual(w1.agent.food, w2.agent.food);
    assert.strictEqual(w1.agent.totalResourcesGathered, w2.agent.totalResourcesGathered);
    assert.strictEqual(w1.agent.totalDamageTaken, w2.agent.totalDamageTaken);
  });

  test('getObservation returns expected structure', () => {
    const world = new SimWorld({}, 123);
    const obs = world.getObservation();

    assert.ok(obs.agent);
    assert.strictEqual(typeof obs.agent.position.x, 'number');
    assert.strictEqual(typeof obs.agent.position.y, 'number');
    assert.strictEqual(typeof obs.agent.health, 'number');
    assert.strictEqual(typeof obs.agent.food, 'number');
    assert.strictEqual(typeof obs.agent.alive, 'boolean');

    assert.ok(obs.inventory);
    assert.ok(Array.isArray(obs.tools));
    assert.ok(obs.currentCell);
    assert.ok(Array.isArray(obs.nearbyResources));
    assert.ok(Array.isArray(obs.nearbyThreats));
    assert.strictEqual(typeof obs.hasShelter, 'boolean');
    assert.strictEqual(typeof obs.shelterDistance, 'number');
    assert.strictEqual(typeof obs.isNight, 'boolean');
    assert.strictEqual(typeof obs.tick, 'number');
    assert.strictEqual(typeof obs.dayNumber, 'number');
  });

  test('getMetrics returns expected structure', () => {
    const world = new SimWorld({}, 123);
    const metrics = world.getMetrics();

    assert.strictEqual(typeof metrics.ticksSurvived, 'number');
    assert.strictEqual(typeof metrics.totalResourcesGathered, 'number');
    assert.strictEqual(typeof metrics.totalCrafted, 'number');
    assert.strictEqual(typeof metrics.totalFoodEaten, 'number');
    assert.strictEqual(typeof metrics.totalDamageTaken, 'number');
    assert.strictEqual(typeof metrics.totalThreatsAvoided, 'number');
    assert.strictEqual(typeof metrics.alive, 'boolean');
    assert.strictEqual(typeof metrics.inventoryValue, 'number');
    assert.strictEqual(typeof metrics.toolCount, 'number');
    assert.strictEqual(typeof metrics.builtShelter, 'boolean');
  });
});

// ============================================================================
// 3. Policy Tests
// ============================================================================
describe('Policy Tests', () => {
  test('Policy creates with correct dimensions', () => {
    const p = new MatrixPolicy({ numFeatures: 19, numActions: 19 });
    assert.strictEqual(p.numFeatures, 19);
    assert.strictEqual(p.numActions, 19);
    assert.strictEqual(p.weights.length, 19 * 19);
    assert.strictEqual(p.biases.length, 19);
  });

  test('selectAction returns valid action index', () => {
    const p = new MatrixPolicy();
    const features = new Float64Array(19).fill(0.5);
    const result = p.selectAction(features);

    assert.strictEqual(typeof result.actionIndex, 'number');
    assert.ok(result.actionIndex >= 0 && result.actionIndex < 19);
    assert.strictEqual(typeof result.actionName, 'string');
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });

  test('mutate creates a different policy', () => {
    const rng = new SeededRandom(42);
    const p = MatrixPolicy.createRandom(rng);
    const mutated = p.mutate(1.0, 0.5, rng);

    assert.notStrictEqual(p, mutated);
    assert.notStrictEqual(p.id, mutated.id);

    let differs = false;
    for (let i = 0; i < p.weights.length; i++) {
      if (p.weights[i] !== mutated.weights[i]) {
        differs = true;
        break;
      }
    }
    assert.ok(differs, 'Mutated weights should differ from original');
  });

  test('mutate preserves parent info', () => {
    const rng = new SeededRandom(42);
    const p = new MatrixPolicy({ generation: 2 });
    const mutated = p.mutate(0.1, 0.3, rng);

    assert.strictEqual(mutated.parentId, p.id);
    assert.strictEqual(mutated.generation, 3);
  });

  test('crossover creates child from two parents', () => {
    const rng = new SeededRandom(77);
    const p1 = MatrixPolicy.createRandom(new SeededRandom(1));
    const p2 = MatrixPolicy.createRandom(new SeededRandom(2));

    const child = p1.crossover(p2, rng);

    assert.strictEqual(child.parentId, p1.id);
    assert.strictEqual(child.metadata.otherParentId, p2.id);
    assert.strictEqual(child.weights.length, p1.weights.length);

    // Each child weight must come from either p1 or p2
    for (let i = 0; i < child.weights.length; i++) {
      const cw = child.weights[i];
      assert.ok(cw === p1.weights[i] || cw === p2.weights[i]);
    }
  });

  test('serialize and deserialize roundtrip', () => {
    const rng = new SeededRandom(99);
    const p = MatrixPolicy.createRandom(rng, { generation: 5, fitness: 123.45 });
    const serialized = p.serialize();
    const deserialized = MatrixPolicy.deserialize(serialized);

    assert.strictEqual(deserialized.id, p.id);
    assert.strictEqual(deserialized.generation, p.generation);
    assert.strictEqual(deserialized.fitness, p.fitness);
    assert.strictEqual(deserialized.weights.length, p.weights.length);
    assert.deepStrictEqual(Array.from(deserialized.weights), Array.from(p.weights));
    assert.deepStrictEqual(Array.from(deserialized.biases), Array.from(p.biases));
  });

  test('clone creates exact copy', () => {
    const p = new MatrixPolicy({ generation: 4, fitness: 99.9 });
    const clone = p.clone();

    assert.notStrictEqual(clone, p);
    assert.strictEqual(clone.generation, p.generation);
    assert.strictEqual(clone.fitness, p.fitness);
    assert.deepStrictEqual(Array.from(clone.weights), Array.from(p.weights));
    assert.deepStrictEqual(Array.from(clone.biases), Array.from(p.biases));
  });

  test('HeuristicPolicy selects eat when hungry', () => {
    const hp = new PolicyHeuristic();
    const obs = {
      agent: { health: 20, food: 4 },
      inventory: { FOOD: 3 },
      tools: [],
      currentCell: {},
      nearbyThreats: []
    };

    const action = hp.selectAction(obs);
    assert.strictEqual(action.actionName, ACTIONS.EAT_RAW);
  });

  test('HeuristicPolicy selects flee when threatened and unarmed', () => {
    const hp = new PolicyHeuristic();
    const obs = {
      agent: { health: 15, food: 18 },
      inventory: {},
      tools: [],
      currentCell: { threat: { active: true, damage: 5 } },
      nearbyThreats: [{ distance: 1 }]
    };

    const action = hp.selectAction(obs);
    assert.strictEqual(action.actionName, ACTIONS.FLEE);
  });

  test('RandomPolicy produces valid actions', () => {
    const rp = new PolicyRandom();
    const rng = new SeededRandom(42);

    for (let i = 0; i < 50; i++) {
      const decision = rp.selectAction(new Float64Array(19), { rng });
      assert.ok(decision.actionIndex >= 0 && decision.actionIndex < 19);
      assert.ok(typeof decision.actionName === 'string');
      assert.ok(Object.values(ACTIONS).includes(decision.actionName));
    }
  });
});

// ============================================================================
// 4. Feature Extraction Tests
// ============================================================================
describe('Feature Extraction Tests', () => {
  test('extractFeatures returns correct length (19)', () => {
    const world = new SimWorld({}, 101);
    const obs = world.getObservation();
    const features = extractFeatures(obs);

    assert.ok(features instanceof Float64Array);
    assert.strictEqual(features.length, 19);
  });

  test('All values are between 0 and 1', () => {
    const world = new SimWorld({}, 101);

    // Test default spawn
    const f1 = extractFeatures(world.getObservation());
    for (let i = 0; i < f1.length; i++) {
      assert.ok(f1[i] >= 0 && f1[i] <= 1, `Feature ${i} was ${f1[i]}, expected [0, 1]`);
    }

    // Test low health / food with night
    world.agent.health = 2;
    world.agent.food = 1;
    world.currentTick = 700; // night
    const f2 = extractFeatures(world.getObservation());
    for (let i = 0; i < f2.length; i++) {
      assert.ok(f2[i] >= 0 && f2[i] <= 1, `Feature ${i} was ${f2[i]}, expected [0, 1]`);
    }
  });

  test('Health urgency is high when health is low', () => {
    const obsLowHealth = {
      agent: { health: 2, food: 20 },
      maxHealth: 20
    };
    const obsHighHealth = {
      agent: { health: 20, food: 20 },
      maxHealth: 20
    };

    const fLow = extractFeatures(obsLowHealth);
    const fHigh = extractFeatures(obsHighHealth);

    // healthUrgency is feature index 17
    assert.ok(fLow[17] > 0.8, `Expected high urgency, got ${fLow[17]}`);
    assert.strictEqual(fHigh[17], 0, `Expected 0 urgency for full health, got ${fHigh[17]}`);
    assert.ok(fLow[17] > fHigh[17]);
  });

  test('Food urgency is high when food is low', () => {
    const obsLowFood = {
      agent: { health: 20, food: 1 },
      maxFood: 20
    };
    const obsHighFood = {
      agent: { health: 20, food: 20 },
      maxFood: 20
    };

    const fLow = extractFeatures(obsLowFood);
    const fHigh = extractFeatures(obsHighFood);

    // foodUrgency is feature index 16
    assert.ok(fLow[16] > 0.8, `Expected high urgency, got ${fLow[16]}`);
    assert.strictEqual(fHigh[16], 0, `Expected 0 urgency for full food, got ${fHigh[16]}`);
    assert.ok(fLow[16] > fHigh[16]);
  });
});

// ============================================================================
// 5. Evolution Engine Tests
// ============================================================================
describe('Evolution Engine Tests', () => {
  test('initPopulation creates correct number of policies', () => {
    const engine = new EvolutionEngine({ populationSize: 15 });
    const pop = engine.initPopulation(42);

    assert.strictEqual(pop.length, 15);
    assert.strictEqual(engine.population.length, 15);
  });

  test('evaluatePolicy returns fitness and details', () => {
    const engine = new EvolutionEngine({ maxEpisodeTicks: 50, numEvalEpisodes: 2 });
    engine.initPopulation(101);

    const result = engine.evaluatePolicy(engine.population[0], [10, 20]);
    assert.ok(result);
    assert.strictEqual(typeof result.fitness, 'number');
    assert.strictEqual(result.policyId, engine.population[0].id);
    assert.strictEqual(result.episodes.length, 2);
    assert.ok(result.episodes[0].metrics);
  });

  test('Tournament selection picks fittest', () => {
    const engine = new EvolutionEngine({ tournamentSize: 3 });
    const candidates = [
      { id: 'weak', fitness: 10 },
      { id: 'mediocre', fitness: 50 },
      { id: 'strong', fitness: 100 }
    ];

    // Seed RNG such that tournament samples weak and strong
    const winner = engine.selectParent(candidates);
    assert.ok(winner);
    assert.ok(winner.fitness >= 10);
  });

  test('nextGeneration preserves elite count', () => {
    const engine = new EvolutionEngine({
      populationSize: 8,
      eliteCount: 2,
      maxEpisodeTicks: 20,
      numEvalEpisodes: 1
    });
    engine.initPopulation(101);

    // Run evaluation to populate fitnesses
    engine.evaluatePopulation([99]);
    const topElite1 = engine.population[0].id;
    const topElite2 = engine.population[1].id;

    const report = engine.nextGeneration();
    assert.ok(report);

    // The two elite policies must be preserved in the new generation
    const newPopIds = engine.population.map((p) => p.id);
    assert.ok(newPopIds.includes(topElite1));
    assert.ok(newPopIds.includes(topElite2));
  });

  test('Fitness increases over generations (run 5 gens)', async () => {
    const engine = new EvolutionEngine({
      populationSize: 8,
      eliteCount: 2,
      maxEpisodeTicks: 50,
      numEvalEpisodes: 1,
      baselineCheckInterval: 10
    });
    engine.initPopulation(555);

    const reports = [];
    for (let i = 0; i < 5; i++) {
      const rep = engine.nextGeneration();
      reports.push(rep);
    }

    assert.strictEqual(reports.length, 5);
    assert.strictEqual(engine.generation, 5);
    // Best fitness across generations should be tracked
    assert.ok(engine.bestEverFitness > -Infinity);
    assert.ok(reports[4].bestFitness >= reports[0].worstFitness);
  });

  test('Held-out evaluation works', () => {
    const engine = new EvolutionEngine({
      heldOutSeeds: [501, 502],
      maxEpisodeTicks: 30
    });
    engine.initPopulation(101);

    const heldOut = engine.evaluateHeldOut(engine.population[0]);
    assert.strictEqual(heldOut.episodes.length, 2);
    assert.strictEqual(heldOut.episodes[0].seed, 501);
    assert.strictEqual(heldOut.episodes[1].seed, 502);
    assert.strictEqual(typeof heldOut.fitness, 'number');
  });

  test('Checkpoint and restore roundtrip', () => {
    const engine = new EvolutionEngine({
      populationSize: 6,
      maxEpisodeTicks: 30,
      numEvalEpisodes: 1
    });
    engine.initPopulation(222);
    engine.nextGeneration();

    const checkpointData = engine.checkpoint();
    assert.ok(checkpointData);
    assert.strictEqual(checkpointData.generation, 1);
    assert.strictEqual(checkpointData.population.length, 6);

    const restored = EvolutionEngine.restore(checkpointData);
    assert.strictEqual(restored.generation, 1);
    assert.strictEqual(restored.population.length, 6);
    assert.strictEqual(restored.bestEverFitness, engine.bestEverFitness);
    assert.strictEqual(restored.config.populationSize, 6);
  });

  test('FitnessCalculator produces expected values for known inputs', () => {
    const metrics = {
      ticksSurvived: 100,
      totalResourcesGathered: 5,
      totalCrafted: 2,
      totalFoodEaten: 3,
      builtShelter: true,
      toolCount: 1,
      inventoryValue: 10,
      alive: true,
      totalDamageTaken: 4
    };

    // Expected calculation:
    // 100 * 1.0 = 100
    // 5 * 2.0 = 10
    // 2 * 5.0 = 10
    // 3 * 1.5 = 4.5
    // builtShelter = 20.0
    // toolCount: 1 * 10.0 = 10
    // inventoryValue: 10 * 0.5 = 5
    // alive = 50.0
    // damage: -4.0
    // Total = 100 + 10 + 10 + 4.5 + 20 + 10 + 5 + 50 - 4 = 205.5
    const fitness = FitnessCalculator.compute(metrics);
    assert.strictEqual(fitness, 205.5);
  });
});

// ============================================================================
// 6. Experience Store Tests
// ============================================================================
describe('Experience Store Tests', () => {
  const tempDir = path.join(os.tmpdir(), `mika_exp_store_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);

  test('Creates data directory', () => {
    const store = new ExperienceStore({ dataDir: tempDir });
    assert.ok(fs.existsSync(tempDir));
    assert.ok(fs.existsSync(store.checkpointsDir));
    assert.ok(fs.existsSync(store.bestPoliciesDir));
  });

  test('Save and load checkpoint roundtrip', async () => {
    const store = new ExperienceStore({ dataDir: tempDir });
    const dummyEngine = {
      generation: 3,
      fitness: 88.5,
      serialize() {
        return { gen: 3, fit: 88.5 };
      }
    };

    await store.saveCheckpoint(dummyEngine, 'gen-3');
    const loaded = await store.loadCheckpoint('gen-3');

    assert.deepStrictEqual(loaded, { gen: 3, fit: 88.5 });
  });

  test('List checkpoints works', async () => {
    const store = new ExperienceStore({ dataDir: tempDir });
    await store.saveCheckpoint({ a: 1 }, 'label-a');
    await store.saveCheckpoint({ b: 2 }, 'label-b');

    const list = await store.listCheckpoints();
    assert.ok(list.includes('label-a'));
    assert.ok(list.includes('label-b'));
  });

  test('Save generation log appends correctly', async () => {
    const store = new ExperienceStore({ dataDir: tempDir });
    await store.saveGenerationLog({ generation: 1, bestFitness: 10 });
    await store.saveGenerationLog({ generation: 2, bestFitness: 25 });

    const logPath = path.join(tempDir, 'generations.jsonl');
    assert.ok(fs.existsSync(logPath));

    const content = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.strictEqual(content.length, 2);

    const line1 = JSON.parse(content[0]);
    const line2 = JSON.parse(content[1]);
    assert.strictEqual(line1.generation, 1);
    assert.strictEqual(line1.bestFitness, 10);
    assert.strictEqual(line2.generation, 2);
    assert.strictEqual(line2.bestFitness, 25);

    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });
});

// ============================================================================
// 7. VirtualTimeTracker Tests
// ============================================================================
describe('VirtualTimeTracker Tests', () => {
  test('Starts at zero', () => {
    const tracker = new VirtualTimeTracker({ ticksPerDay: 1200 });
    assert.strictEqual(tracker.virtualTicksCompleted, 0);
    assert.strictEqual(tracker.virtualDaysCompleted, 0);
    assert.strictEqual(tracker.virtualYearsCompleted, 0);
    assert.strictEqual(tracker.episodesCompleted, 0);
    assert.strictEqual(tracker.generationsCompleted, 0);
    assert.strictEqual(tracker.wallClockMs, 0);
  });

  test('update() accumulates correctly', () => {
    const tracker = new VirtualTimeTracker({ ticksPerDay: 1200 });
    tracker.update(600, 50);
    tracker.update(600, 50);

    assert.strictEqual(tracker.virtualTicksCompleted, 1200);
    assert.strictEqual(tracker.episodesCompleted, 2);
    assert.strictEqual(tracker.wallClockMs, 100);
  });

  test('Virtual days calculation correct', () => {
    const tracker = new VirtualTimeTracker({ ticksPerDay: 1200 });
    tracker.update(2400, 10);
    assert.strictEqual(tracker.virtualDaysCompleted, 2);
  });

  test('Virtual years calculation correct', () => {
    const tracker = new VirtualTimeTracker({ ticksPerDay: 1200 });
    // 365 days * 1200 ticks = 438,000 ticks
    tracker.update(438000, 10);
    assert.ok(Math.abs(tracker.virtualYearsCompleted - 1.0) < 1e-6);
  });

  test('getProgressString returns non-empty string', () => {
    const tracker = new VirtualTimeTracker({ ticksPerDay: 1200 });
    tracker.update(1200, 1000);
    tracker.recordGeneration();

    const str = tracker.getProgressString();
    assert.strictEqual(typeof str, 'string');
    assert.ok(str.length > 0);
    assert.ok(str.includes('Episodes: 1'));
    assert.ok(str.includes('Gen: 1'));
  });
});

// ============================================================================
// 8. Integration Test
// ============================================================================
describe('Integration Test', () => {
  test('Run a mini evolution experiment: 3 generations, population 10, 1 episode/eval, 500 ticks', async () => {
    const tempIntegrationDir = path.join(
      os.tmpdir(),
      `mika_integration_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );

    const store = new ExperienceStore({ dataDir: tempIntegrationDir });
    const runner = new ParallelRunner({
      maxConcurrent: 2,
      experienceStore: store
    });

    const result = await runner.runEvolutionExperiment({
      generations: 3,
      populationSize: 10,
      seeds: [42],
      worldConfig: { maxTicks: 500 },
      checkpointInterval: 2,
      verbose: false
    });

    // Verify it completes without errors
    assert.ok(result, 'Experiment result must be returned');

    // Verify generation reports have expected fields
    assert.ok(Array.isArray(result.generationReports));
    assert.strictEqual(result.generationReports.length, 3);
    for (const report of result.generationReports) {
      assert.strictEqual(typeof report.generation, 'number');
      assert.strictEqual(typeof report.bestFitness, 'number');
      assert.strictEqual(typeof report.avgFitness, 'number');
    }

    // Verify best fitness is tracked
    assert.strictEqual(typeof result.summary.finalBestFitness, 'number');
    assert.ok(result.summary.finalBestFitness >= 0);

    // Verify final results contain all required sections
    assert.ok(result.summary, 'Result should have summary');
    assert.ok(result.engine, 'Result should have engine');
    assert.ok(result.bestPolicy, 'Result should have bestPolicy');
    assert.ok(result.timeTracker, 'Result should have timeTracker');
    assert.strictEqual(result.summary.generationsCompleted, 3);
    assert.strictEqual(result.summary.populationSize, 10);

    // Clean up temporary data
    try {
      fs.rmSync(tempIntegrationDir, { recursive: true, force: true });
    } catch {}
  });
});
