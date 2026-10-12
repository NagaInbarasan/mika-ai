import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  GOAL_DEFINITIONS,
  resolveGoalPlan,
  countAvailableBuildingBlocks,
  countWoodLogs,
  countPlanks,
  countTotalPickaxes,
  countEdibleFood,
  getItemCount
} from '../src/learning/goals.js';

import {
  EmergencyShelterManager,
  defaultShelterManager
} from '../src/survival/shelter.js';

import {
  SURVIVAL_RECIPES,
  getInventoryCount,
  validateRecipePrerequisites,
  verifyCraftingResult,
  executeSafeCraft
} from '../src/survival/crafting.js';

import {
  SURVIVAL_CONFIG,
  GoalExecutionTracker,
  isNightOrDusk,
  evaluateThreatLevel,
  selectContextualGoal
} from '../src/survival/priority.js';

import {
  FAILURE_CATEGORIES,
  evaluateGoalOutcome
} from '../src/learning/evaluate.js';

import { PersistentMemoryStore } from '../src/learning/memory.js';

// ============================================================================
// Scenario 1: Daytime spawn with trees and enough time to prepare
// ============================================================================
test('Scenario 1: Daytime spawn with trees prioritizes wood gathering over emergency shelter', () => {
  const daytimeObs = {
    agent: { health: 20, food: 20, isAlive: true },
    environment: { is_night: false, time_of_day: 1000 },
    inventory: [],
    nearby_resources: [
      { name: 'oak_log', distance: 3.5 },
      { name: 'dirt', distance: 1.2 }
    ],
    nearby_threats: [],
    shelter_safety: { safe: false }
  };

  const selected = selectContextualGoal(daytimeObs);
  // Should not panic build shelter at morning tick 1000 with full health and no threats
  assert.strictEqual(selected.tier, 4); // Proactive dirt block or wood gathering ladder
  assert.ok(
    selected.goalId === 'GATHER_SHELTER_BLOCKS' || selected.goalId === 'GATHER_WOOD_LOGS',
    `Expected resource gathering, got: ${selected.goalId}`
  );

  // If bot already has dirt blocks, daytime spawn progresses to wood
  const withDirtObs = {
    ...daytimeObs,
    inventory: [{ name: 'dirt', count: 10 }]
  };
  const step2 = selectContextualGoal(withDirtObs);
  assert.strictEqual(step2.tier, 5);
  assert.strictEqual(step2.goalId, 'GATHER_WOOD_LOGS');
});

// ============================================================================
// Scenario 2: Nighttime spawn with sufficient dirt but no tools
// ============================================================================
test('Scenario 2: Nighttime spawn with sufficient dirt builds emergency shelter and verifies safety', async () => {
  const nightObs = {
    agent: { health: 20, food: 20, isAlive: true },
    environment: { is_night: true, time_of_day: 14500 },
    inventory: [{ name: 'dirt', count: 12 }],
    nearby_threats: [],
    shelter_safety: { safe: false }
  };

  const selected = selectContextualGoal(nightObs);
  assert.strictEqual(selected.tier, 2);
  assert.strictEqual(selected.goalId, 'BUILD_EMERGENCY_SHELTER');

  // Mock bot to test emergency shelter construction and verification
  const mockBot = {
    entity: {
      position: { x: 10, y: 64, z: 20, offset: (dx, dy, dz) => ({ x: 10 + dx, y: 64 + dy, z: 20 + dz }) }
    },
    inventory: {
      items: () => [{ name: 'dirt', count: 12 }]
    },
    collectObservation: () => nightObs,
    mockShelterState: { hasRoof: true, wallCoverage: 4 },
    entities: {}
  };

  const shelterManager = new EmergencyShelterManager();
  const buildResult = await shelterManager.buildEmergencyShelter(mockBot);

  assert.strictEqual(buildResult.status, 'success');
  assert.strictEqual(buildResult.data.is_safe, true);
  assert.strictEqual(buildResult.data.has_roof, true);
  assert.strictEqual(buildResult.data.wall_coverage, 4);
});

// ============================================================================
// Scenario 3: Night approaching while MIKA has low health
// ============================================================================
test('Scenario 3: Night approaching with low health prioritizes immediate threat evasion and emergency shelter', () => {
  // Case A: Critical threat nearby with low health
  const criticalThreatObs = {
    agent: { health: 5, food: 15, isAlive: true },
    environment: { is_night: true, time_of_day: 13000 },
    inventory: [{ name: 'dirt', count: 10 }],
    nearby_threats: [{ name: 'zombie', distance: 3.1 }],
    shelter_safety: { safe: false }
  };

  const choiceA = selectContextualGoal(criticalThreatObs);
  assert.strictEqual(choiceA.tier, 1);
  assert.strictEqual(choiceA.goalId, 'SURVIVE_IMMEDIATE_THREAT');

  // Case B: Low health at dusk without mob in face -> Tier 2 Emergency Shelter
  const duskLowHealthObs = {
    agent: { health: 6, food: 15, isAlive: true },
    environment: { is_night: false, time_of_day: 11000 }, // Dusk warning
    inventory: [{ name: 'dirt', count: 10 }],
    nearby_threats: [],
    shelter_safety: { safe: false }
  };

  const choiceB = selectContextualGoal(duskLowHealthObs);
  assert.strictEqual(choiceB.tier, 2);
  assert.strictEqual(choiceB.goalId, 'BUILD_EMERGENCY_SHELTER');
});

// ============================================================================
// Scenario 4: Missing ingredients during a crafting attempt
// ============================================================================
test('Scenario 4: Missing ingredients during crafting detects specific deficit and fails cleanly', () => {
  const inventory = [{ name: 'oak_planks', count: 1 }]; // Missing 2 planks, 2 sticks, and crafting table
  const validation = validateRecipePrerequisites('wooden_pickaxe', inventory, false);

  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.missingStation, true); // Requires crafting table
  assert.strictEqual(validation.missingIngredients.length, 2);

  const plankDeficit = validation.missingIngredients.find(m => m.name === 'planks');
  assert.strictEqual(plankDeficit.shortage, 2);

  const stickDeficit = validation.missingIngredients.find(m => m.name === 'stick');
  assert.strictEqual(stickDeficit.shortage, 2);

  // Evaluate failure outcome
  const evaluation = evaluateGoalOutcome({
    goalId: 'CRAFT_WOODEN_PICKAXE',
    preObservation: { agent: { health: 20 }, inventory },
    postObservation: { agent: { health: 20 }, inventory },
    action: 'craft_item',
    args: { item: 'wooden_pickaxe' },
    actionResult: {
      status: 'failed',
      error_code: 'MISSING_INGREDIENTS',
      error: 'Missing ingredients to craft wooden_pickaxe'
    }
  });

  assert.strictEqual(evaluation.goalAchieved, false);
  assert.strictEqual(evaluation.failureCategory, FAILURE_CATEGORIES.MISSING_INGREDIENTS);
  assert.ok(evaluation.recommendedCorrection.includes('Gather required raw materials'));
});

// ============================================================================
// Scenario 5: Shelter placement failure or obstructed building location
// ============================================================================
test('Scenario 5: Shelter site obstruction or hazard is detected and classified', async () => {
  const hazardBot = {
    entity: {
      position: { x: 50, y: 64, z: -30, offset: () => ({ x: 50, y: 63, z: -30 }) }
    },
    blockAt: () => ({ name: 'lava' }), // Hazardous block underneath!
    inventory: {
      items: () => [{ name: 'dirt', count: 10 }]
    },
    collectObservation: () => ({ inventory: [{ name: 'dirt', count: 10 }] })
  };

  const shelterManager = new EmergencyShelterManager();
  const siteAssessment = shelterManager.assessShelterSite(hazardBot);

  assert.strictEqual(siteAssessment.suitable, false);
  assert.ok(siteAssessment.reason.includes('Hazardous block'));

  const buildResult = await shelterManager.buildEmergencyShelter(hazardBot);
  assert.strictEqual(buildResult.status, 'failed');
  assert.strictEqual(buildResult.error_code, 'UNSUITABLE_SITE');

  // Evaluate outcome classification
  const evaluation = evaluateGoalOutcome({
    goalId: 'BUILD_EMERGENCY_SHELTER',
    preObservation: { agent: { health: 20 }, inventory: [{ name: 'dirt', count: 10 }] },
    postObservation: { agent: { health: 20 }, inventory: [{ name: 'dirt', count: 10 }], shelter_safety: { safe: false } },
    action: 'build_shelter',
    actionResult: buildResult
  });

  assert.strictEqual(evaluation.goalAchieved, false);
  assert.strictEqual(evaluation.failureCategory, FAILURE_CATEGORIES.OBSTRUCTED_LOCATION);
  assert.ok(evaluation.recommendedCorrection.includes('clear, level ground'));
});

// ============================================================================
// Scenario 6: A failed action followed by successful recovery
// ============================================================================
test('Scenario 6: Failed crafting followed by prerequisite resolution succeeds', async () => {
  // Step 1: Crafting sticks fails because of 0 planks
  const initialInv = [{ name: 'oak_log', count: 2 }]; // Has logs, but no planks!
  const val1 = validateRecipePrerequisites('stick', initialInv, false);
  assert.strictEqual(val1.valid, false);

  // Recovery Step: Convert logs to planks
  const plankCraft = await executeSafeCraft({ inventory: initialInv }, 'oak_planks', 1);
  assert.strictEqual(plankCraft.status, 'success');

  // Step 2: Now inventory has 4 planks -> craft sticks succeeds
  const updatedInv = [{ name: 'oak_log', count: 1 }, { name: 'oak_planks', count: 4 }];
  const val2 = validateRecipePrerequisites('stick', updatedInv, false);
  assert.strictEqual(val2.valid, true);

  const stickCraft = await executeSafeCraft({ inventory: updatedInv }, 'stick', 1);
  assert.strictEqual(stickCraft.status, 'success');
  assert.strictEqual(stickCraft.data.verification.verified, true);
});

// ============================================================================
// Scenario 7: Repeated failure without an infinite retry loop
// ============================================================================
test('Scenario 7: GoalExecutionTracker prevents infinite retry loops after repeated failure', () => {
  const tracker = new GoalExecutionTracker(3);
  const obs = {
    agent: { health: 20, food: 20 },
    environment: { is_night: false, time_of_day: 1000 },
    inventory: [{ name: 'dirt', count: 10 }],
    nearby_resources: [{ name: 'stone', distance: 2 }]
  };

  // Simulate 3 failures for MINE_STONE
  tracker.recordAttempt('MINE_STONE', false, 'No pickaxe');
  assert.strictEqual(tracker.isGoalBlocked('MINE_STONE'), false);

  tracker.recordAttempt('MINE_STONE', false, 'No pickaxe');
  assert.strictEqual(tracker.isGoalBlocked('MINE_STONE'), false);

  tracker.recordAttempt('MINE_STONE', false, 'No pickaxe');
  assert.strictEqual(tracker.isGoalBlocked('MINE_STONE'), true); // Blocked after 3 consecutive failures!

  // Priority engine must not pick MINE_STONE when blocked
  const selected = selectContextualGoal(obs, null, tracker);
  assert.notStrictEqual(selected.goalId, 'MINE_STONE');
});

// ============================================================================
// Scenario 8: A later run in which a relevant saved lesson changes MIKA's plan
// ============================================================================
test('Scenario 8: Saved lesson persists to disk and informs subsequent planning run', () => {
  const testStorePath = path.join('./data/test', 'test_survival_lessons.json');
  const testLessonsPath = path.join('./data/test', 'test_survival_lessons_store.json');
  if (fs.existsSync(testStorePath)) fs.unlinkSync(testStorePath);
  if (fs.existsSync(testLessonsPath)) fs.unlinkSync(testLessonsPath);

  // Run 1: Bot records mistake and lesson
  const memory1 = new PersistentMemoryStore({ filePath: testStorePath, lessonsFilePath: testLessonsPath });
  memory1.storeSurvivalLesson({
    goalId: 'MINE_STONE',
    situationPattern: 'mine_stone_without_pickaxe',
    failureCategory: 'WRONG_TOOL',
    evidence: 'Mined stone with empty hand and received zero cobblestone',
    correction: 'Must craft wooden pickaxe before attempting to mine stone',
    wasSuccessful: false
  });

  // Run 2: Fresh instance (simulating bot reboot) reloads lessons
  const memory2 = new PersistentMemoryStore({ filePath: testStorePath, lessonsFilePath: testLessonsPath });
  const retrievedLessons = memory2.getRelevantLessons('MINE_STONE');

  assert.strictEqual(retrievedLessons.length, 1);
  assert.strictEqual(retrievedLessons[0].failure_category, 'WRONG_TOOL');
  assert.ok(retrievedLessons[0].correction.includes('wooden pickaxe'));

  // Clean up
  if (fs.existsSync(testStorePath)) fs.unlinkSync(testStorePath);
  if (fs.existsSync(testLessonsPath)) fs.unlinkSync(testLessonsPath);
});

// ============================================================================
// Scenario 9: Existing resources make unnecessary crafting or gathering avoidable
// ============================================================================
test('Scenario 9: resolveGoalPlan avoids redundant steps when resources already exist', () => {
  // Case A: Bot already has wooden pickaxe in inventory
  const obsWithPickaxe = {
    inventory: [{ name: 'wooden_pickaxe', count: 1 }]
  };
  const planA = resolveGoalPlan('CRAFT_WOODEN_PICKAXE', obsWithPickaxe);
  assert.strictEqual(planA.length, 0); // Already completed, 0 redundant actions!

  // Case B: Bot already has 4 planks, 2 sticks, and a crafting table
  const obsWithMaterials = {
    inventory: [
      { name: 'oak_planks', count: 4 },
      { name: 'stick', count: 2 },
      { name: 'crafting_table', count: 1 }
    ]
  };
  const planB = resolveGoalPlan('CRAFT_WOODEN_PICKAXE', obsWithMaterials);
  // Should NOT gather logs, should NOT craft planks, should NOT craft sticks, should NOT craft table
  assert.deepStrictEqual(planB, ['CRAFT_WOODEN_PICKAXE']);
});

// ============================================================================
// Scenario 10: Human !good and !bad feedback affecting subsequent decisions
// ============================================================================
test('Scenario 10: Human !good and !bad feedback integrates into evaluation and lesson confidence', () => {
  const testStorePath = path.join('./data/test', 'test_feedback_store.json');
  const testLessonsPath = path.join('./data/test', 'test_feedback_lessons.json');
  if (fs.existsSync(testStorePath)) fs.unlinkSync(testStorePath);
  if (fs.existsSync(testLessonsPath)) fs.unlinkSync(testLessonsPath);

  const memory = new PersistentMemoryStore({ filePath: testStorePath, lessonsFilePath: testLessonsPath });

  // Test !good feedback boosts confidence
  const goodLesson = memory.recordPlayerFeedback({
    goalId: 'BUILD_EMERGENCY_SHELTER',
    isGood: true,
    message: 'Great job sheltering before sunset'
  });
  assert.ok(goodLesson.confidence >= 0.8, `Expected confidence >= 0.8, got: ${goodLesson.confidence}`);
  assert.strictEqual(goodLesson.status, 'active');

  // Test !bad feedback reduces score and marks failure
  const badLesson = memory.recordPlayerFeedback({
    goalId: 'GATHER_WOOD_LOGS',
    isGood: false,
    message: 'Do not punch trees during midnight with creepers nearby'
  });
  assert.ok(badLesson.confidence <= 0.35, `Expected low confidence, got: ${badLesson.confidence}`);
  assert.strictEqual(badLesson.failure_category, 'human_disapproval');

  // Verify evaluateGoalOutcome reflects !bad feedback even if action technically succeeded
  const evalWithBad = evaluateGoalOutcome({
    goalId: 'GATHER_WOOD_LOGS',
    preObservation: { agent: { health: 20 }, inventory: [] },
    postObservation: { agent: { health: 20 }, inventory: [{ name: 'oak_log', count: 1 }] },
    action: 'collect_resource',
    actionResult: { status: 'success' },
    feedback: { type: 'bad', message: 'Wandered into dark' }
  });

  assert.strictEqual(evalWithBad.goalAchieved, false);
  assert.ok(evalWithBad.failureReason.includes('Player marked action as bad'));

  // Clean up
  if (fs.existsSync(testStorePath)) fs.unlinkSync(testStorePath);
  if (fs.existsSync(testLessonsPath)) fs.unlinkSync(testLessonsPath);
});
