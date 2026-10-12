import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// Foundation 1: World Observation
import { collectObservation } from '../src/minecraft/observe.js';

// Foundation 2: Goal Planner
import { GoalPlanner, defaultGoalPlanner } from '../src/planner/goal.js';
import { GOAL_DEFINITIONS, resolveGoalPlan } from '../src/learning/goals.js';

// Foundation 3: Action Executor
import { ActionExecutor, validateAction, ALLOWED_ACTIONS } from '../src/actions/index.js';
import { evaluateOutcome } from '../src/evaluation/outcome.js';

// Foundation 4: Survival Policy
import { SurvivalPolicy } from '../src/survival/policy.js';
import { SURVIVAL_CONFIG, selectContextualGoal } from '../src/survival/priority.js';

// Foundation 5: Learning Memory
import { PersistentMemoryStore } from '../src/learning/memory.js';

// Foundation 6: Failure Recovery
import { GoalExecutionTracker } from '../src/survival/priority.js';
import { detectMistake } from '../src/learning/mistake-detector.js';
import { RecoveryManager } from '../src/learning/recovery.js';

// ============================================================================
// Foundation 1: World Observation
// ============================================================================
test('Foundation 1: World Observation reads health, hunger, inventory, position, time, and threats', () => {
  const mockBot = {
    entity: {
      position: { x: 12.34, y: 64.0, z: -55.88 },
      yaw: 1.25,
      pitch: -0.45
    },
    health: 16.5,
    food: 14,
    foodSaturation: 4.0,
    oxygenLevel: 20,
    time: { timeOfDay: 13500 }, // Nighttime
    game: { dimension: 'overworld', gameMode: 'survival' },
    inventory: {
      items: () => [
        { name: 'dirt', count: 16, slot: 36 },
        { name: 'bread', count: 3, slot: 37 }
      ]
    },
    entities: {
      '1': {
        name: 'zombie',
        type: 'mob',
        position: { x: 14.0, y: 64.0, z: -53.0 },
        distanceTo: () => 3.5
      }
    }
  };

  const obs = collectObservation(mockBot, { maxEntityDistance: 16 });

  // 1. Agent State
  assert.strictEqual(obs.agent.health, 16.5);
  assert.strictEqual(obs.agent.food, 14);
  assert.strictEqual(obs.agent.isAlive, true);
  assert.deepStrictEqual(obs.agent.position, { x: 12.3, y: 64.0, z: -55.9 });

  // 2. Environment
  assert.strictEqual(obs.environment.dimension, 'overworld');
  assert.strictEqual(obs.environment.is_night, true);
  assert.strictEqual(obs.environment.timePhase, 'night_dangerous');

  // 3. Inventory
  assert.strictEqual(obs.inventory.length, 2);
  assert.strictEqual(obs.inventory[0].name, 'dirt');
  assert.strictEqual(obs.inventory[0].count, 16);

  // 4. Threats
  assert.ok(obs.nearby_threats.length >= 1);
  assert.strictEqual(obs.nearby_threats[0].name, 'zombie');
});

// ============================================================================
// Foundation 2: Goal Planner
// ============================================================================
test('Foundation 2: Goal Planner decomposes objectives into tasks with prerequisites and avoids redundancy', () => {
  const planner = new GoalPlanner();

  // Case A: Missing prerequisites (No wood logs, no crafting table)
  const emptyObs = {
    agent: { health: 20, food: 20 },
    inventory: []
  };

  const planA = planner.convertObjectiveToPlan('CRAFT_WOODEN_PICKAXE', emptyObs);
  assert.strictEqual(planA.isCompleted, false);
  assert.strictEqual(planA.prerequisitesSatisfied, false);
  // Must first gather wood logs before crafting planks, table, sticks, and pickaxe
  assert.ok(planA.plan.includes('GATHER_WOOD_LOGS'));
  assert.strictEqual(planA.nextImmediateTask, 'GATHER_WOOD_LOGS');

  // Case B: Partial materials available (Already has planks and sticks)
  const partialObs = {
    agent: { health: 20, food: 20 },
    inventory: [
      { name: 'oak_planks', count: 4 },
      { name: 'stick', count: 4 },
      { name: 'crafting_table', count: 1 }
    ]
  };
  const planB = planner.convertObjectiveToPlan('CRAFT_WOODEN_PICKAXE', partialObs);
  assert.strictEqual(planB.prerequisitesSatisfied, true);
  // Redundant log gathering or stick crafting is pruned!
  assert.deepStrictEqual(planB.plan, ['CRAFT_WOODEN_PICKAXE']);
  assert.strictEqual(planB.nextImmediateTask, 'CRAFT_WOODEN_PICKAXE');

  // Case C: Target already completed in inventory
  const completedObs = {
    agent: { health: 20, food: 20 },
    inventory: [{ name: 'wooden_pickaxe', count: 1 }]
  };
  const planC = planner.convertObjectiveToPlan('CRAFT_WOODEN_PICKAXE', completedObs);
  assert.strictEqual(planC.isCompleted, true);
  assert.strictEqual(planC.plan.length, 0);
});

// ============================================================================
// Foundation 3: Action Executor
// ============================================================================
test('Foundation 3: Action Executor validates allowlist and verifies actual delta results', async () => {
  // Reject unsafe arbitrary commands
  assert.strictEqual(validateAction('destroy_entire_world').valid, false);
  assert.strictEqual(validateAction('navigate_to', {}).valid, false); // Missing coordinates
  assert.strictEqual(validateAction('collect_resource', { resource: 'wood' }).valid, true);

  // Measure delta outcomes cleanly
  const preObs = {
    agent: { health: 18, food: 14, isAlive: true, position: { x: 0, y: 64, z: 0 } },
    inventory: [{ name: 'apple', count: 2 }]
  };
  const postObs = {
    agent: { health: 20, food: 18, isAlive: true, position: { x: 0, y: 64, z: 0 } },
    inventory: [{ name: 'apple', count: 1 }]
  };

  const outcome = evaluateOutcome({
    action: 'eat_food',
    args: { food_name: 'apple' },
    executionResult: { status: 'success', duration_ms: 120 },
    preObservation: preObs,
    postObservation: postObs,
    expectedOutcome: 'food restored'
  });

  assert.strictEqual(outcome.food_delta, 4);
  assert.strictEqual(outcome.health_delta, 2);
  assert.strictEqual(outcome.resource_delta.apple, -1);
  assert.ok(outcome.reward > 0);
});

// ============================================================================
// Foundation 4: Survival Policy
// ============================================================================
test('Foundation 4: Survival Policy prioritizes immediate threats and computes retreat vector', () => {
  const policy = new SurvivalPolicy();

  // Mortal danger: Zombie within 3m and low health (5/20)
  const dangerObs = {
    agent: { health: 5, food: 12, position: { x: 10, y: 64, z: 20 } },
    environment: { is_night: true, time_of_day: 14000 },
    inventory: [],
    nearby_threats: [
      { name: 'zombie', distance: 2.8, position: { x: 12, y: 64, z: 20 } }
    ],
    shelter_safety: { safe: false }
  };

  const decision = policy.evaluatePriorities(dangerObs);
  assert.strictEqual(decision.tier, 1);
  assert.strictEqual(decision.goalId, 'SURVIVE_IMMEDIATE_THREAT');
  assert.ok(decision.emergencyRetreat, 'Expected emergency retreat coordinates');
  // Retreat vector must move away from threat (x < 10 since threat is at x = 12)
  assert.ok(decision.emergencyRetreat.x < 10, `Retreat X should be away from threat, got: ${decision.emergencyRetreat.x}`);
});

// ============================================================================
// Foundation 5: Learning Memory
// ============================================================================
test('Foundation 5: Learning Memory records experiences, mistakes, and strategies persistently', () => {
  const testDir = path.join('./data/test', `milestone1_mem_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const memFile = path.join(testDir, 'memory.json');
  const lessonsFile = path.join(testDir, 'lessons.json');
  const strategiesFile = path.join(testDir, 'strategies.json');

  const memoryStore = new PersistentMemoryStore({
    filePath: memFile,
    lessonsFilePath: lessonsFile,
    strategiesFilePath: strategiesFile
  });

  // Store survival lesson
  memoryStore.storeSurvivalLesson({
    goalId: 'MINE_STONE',
    situationPattern: 'mine_stone_without_pickaxe',
    failureCategory: 'WRONG_TOOL',
    evidence: 'Mining stone with empty hand yielded no blocks',
    correction: 'Craft wooden pickaxe first',
    wasSuccessful: false
  });

  // Store task strategy
  const stratResult = memoryStore.recordTaskCompletion({
    goalId: 'GATHER_WOOD_LOGS',
    action: 'collect_resource',
    args: { resource: 'oak_log', count: 3 },
    durationMs: 1450,
    preObservation: { inventory: [] },
    postObservation: { inventory: [{ name: 'oak_log', count: 3 }] }
  });

  assert.ok(stratResult.strategy);
  assert.strictEqual(stratResult.strategy.action, 'collect_resource');

  // Verify reload from disk simulates bot reboot persistence
  const reloaded = new PersistentMemoryStore({
    filePath: memFile,
    lessonsFilePath: lessonsFile,
    strategiesFilePath: strategiesFile
  });

  const lessons = reloaded.getRelevantLessons('MINE_STONE');
  assert.strictEqual(lessons.length, 1);
  assert.strictEqual(lessons[0].failure_category, 'WRONG_TOOL');

  const strategy = reloaded.getTaskStrategy('GATHER_WOOD_LOGS');
  assert.ok(strategy);
  assert.strictEqual(strategy.best_duration_ms, 1450);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Foundation 6: Failure Recovery & Circuit Breaking
// ============================================================================
test('Foundation 6: Failure Recovery diagnoses root causes and halts infinite retry loops', () => {
  const tracker = new GoalExecutionTracker(3);

  // Step 1: Detect mistake diagnostic
  const mistake = detectMistake({
    action: 'craft_item',
    args: { item: 'stick' },
    execution: { status: 'failed', error_code: 'MISSING_INGREDIENTS', error: 'No planks' },
    outcome: { reward: -0.5, task_progress: 0 },
    observationBefore: { inventory: [] },
    observationAfter: { inventory: [] }
  });

  assert.strictEqual(mistake.failure_detected, true);
  assert.strictEqual(mistake.failure_category, 'missing_prerequisite');

  // Step 2: Prevent infinite retry loops
  tracker.recordAttempt('CRAFT_STICKS', false, 'Missing planks');
  assert.strictEqual(tracker.isGoalBlocked('CRAFT_STICKS'), false);

  tracker.recordAttempt('CRAFT_STICKS', false, 'Missing planks');
  assert.strictEqual(tracker.isGoalBlocked('CRAFT_STICKS'), false);

  tracker.recordAttempt('CRAFT_STICKS', false, 'Missing planks');
  // Circuit breaker trips after 3 consecutive failures
  assert.strictEqual(tracker.isGoalBlocked('CRAFT_STICKS'), true);
});

// ============================================================================
// Foundation 10: Safety & Stability Fallbacks
// ============================================================================
test('Foundation 10: Safety limits and fallback heuristics prevent bot freeze during AI silence', () => {
  // If AI reasoning fails or times out, fallback policy yields deterministic safe survival action
  const obs = {
    agent: { health: 10, food: 12 },
    environment: { is_night: false, time_of_day: 2000 },
    inventory: [{ name: 'bread', count: 2 }],
    nearby_threats: []
  };

  const fallbackDecision = selectContextualGoal(obs);
  assert.ok(fallbackDecision.goalId);
  assert.ok(fallbackDecision.tier >= 1 && fallbackDecision.tier <= 6);
  // With food < 14 and bread in inventory, hungry agent falls back to eating food
  assert.strictEqual(fallbackDecision.goalId, 'EAT_FOOD');
});
