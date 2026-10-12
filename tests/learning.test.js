import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PersistentMemoryStore } from '../src/learning/memory.js';
import { detectMistake } from '../src/learning/mistake-detector.js';
import { RecoveryManager } from '../src/learning/recovery.js';
import { validateAction } from '../src/actions/index.js';
import { defaultAdaptiveThinking, AdaptiveThinkingEngine } from '../src/learning/adaptive-thinking.js';
import { AutonomousSurvivalController } from '../src/survival/autonomous.js';

test('detectMistake classifies missing prerequisites and navigation failures', () => {
  // Missing ingredients
  const craftFail = detectMistake({
    action: 'craft_item',
    args: { item: 'stick' },
    execution: { status: 'failed', error_code: 'MISSING_INGREDIENTS', error: 'Missing prerequisite ingredients' },
    outcome: { predicted_outcome_met: false, damage_taken: 0 }
  });
  assert.strictEqual(craftFail.failure_detected, true);
  assert.strictEqual(craftFail.failure_category, 'missing_prerequisite');
  assert.strictEqual(craftFail.situation_pattern, 'craft_item:stick:missing_prerequisite');

  // Navigation unreachable
  const navFail = detectMistake({
    action: 'navigate_to',
    args: { x: 100, z: 200 },
    execution: { status: 'failed', error_code: 'UNREACHABLE_TARGET', error: 'No path found' },
    outcome: { predicted_outcome_met: false, damage_taken: 0 }
  });
  assert.strictEqual(navFail.failure_detected, true);
  assert.strictEqual(navFail.failure_category, 'navigation');
  assert.strictEqual(navFail.situation_pattern, 'navigate:unreachable');
});

test('PersistentMemoryStore persists to disk, reloads, and pattern-matches', () => {
  const testFile = path.join('./data/test', 'test_memory.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const memory = new PersistentMemoryStore({ filePath: testFile });

  const entry = memory.addOrUpdateCorrection({
    situationPattern: 'craft_item:stick:missing_prerequisite',
    failureCategory: 'missing_prerequisite',
    evidence: 'Missing planks to make sticks',
    correction: {
      action: 'collect_resource',
      arguments: { resource: 'dead_bush' },
      reason_summary: 'Harvest dead bush to get sticks in desert'
    },
    wasSuccessful: true
  });

  assert.strictEqual(entry.confidence, 0.75);
  assert.strictEqual(entry.status, 'active');

  // Reload new instance from the same disk file
  const reloaded = new PersistentMemoryStore({ filePath: testFile });
  assert.strictEqual(reloaded.memories.length, 1);

  const matches = reloaded.findRelevantMemories('craft_item:stick:missing_prerequisite');
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].validated_correction.action, 'collect_resource');
  assert.strictEqual(matches[0].validated_correction.arguments.resource, 'dead_bush');

  // Cleanup
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});

test('PersistentMemoryStore downgrades corrections that repeatedly fail', () => {
  const testFile = path.join('./data/test', 'test_downgrade.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const memory = new PersistentMemoryStore({ filePath: testFile });

  // Add initial entry
  memory.addOrUpdateCorrection({
    situationPattern: 'test:pattern',
    failureCategory: 'test',
    correction: { action: 'stop' },
    wasSuccessful: true
  });

  // Multiple failures
  memory.addOrUpdateCorrection({ situationPattern: 'test:pattern', wasSuccessful: false });
  memory.addOrUpdateCorrection({ situationPattern: 'test:pattern', wasSuccessful: false });

  const entry = memory.memories.find(m => m.situation_pattern === 'test:pattern');
  assert.ok(entry.confidence < 0.35, `Confidence should drop below 0.35, got: ${entry.confidence}`);
  assert.strictEqual(entry.status, 'downgraded');

  // findRelevantMemories should exclude downgraded entries
  const retrieved = memory.findRelevantMemories('test:pattern');
  assert.strictEqual(retrieved.length, 0);

  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});

test('RecoveryManager retrieves memory, validates action, and records recovery', async () => {
  const testFile = path.join('./data/test', 'test_recovery_store.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const memoryStore = new PersistentMemoryStore({ filePath: testFile });
  // Seed a known validated fix
  memoryStore.addOrUpdateCorrection({
    situationPattern: 'craft_item:stick:missing_prerequisite',
    failureCategory: 'missing_prerequisite',
    evidence: 'Needs planks or sticks',
    correction: {
      goal: 'inspect inventory for alternative sticks',
      reason_summary: 'Check if sticks or dead bushes are already in inventory',
      action: 'inspect_inventory',
      arguments: {},
      expected_outcome: 'inventory state refreshed',
      risk: 'low',
      confidence: 0.9
    },
    wasSuccessful: true
  });

  const recovery = new RecoveryManager({ memoryStore });

  // Mock bot
  const executedActions = [];
  const recordedFeedbacks = [];
  const mockBot = {
    version: '1.21.11',
    collectObservation: () => ({ agent: { position: { x: 0, y: 64, z: 0 } }, inventory: [] }),
    actions: {
      execute: async (act) => {
        executedActions.push(act);
        return {
          execution: { status: 'success', duration_ms: 10 },
          outcome: { predicted_outcome_met: true, task_progress: 1 }
        };
      }
    },
    recorder: {
      recordFeedback: (fb) => recordedFeedbacks.push(fb)
    }
  };

  const result = await recovery.attemptRecovery({
    bot: mockBot,
    failedStep: {
      action: 'craft_item',
      args: { item: 'stick' },
      execution: { status: 'failed', error_code: 'MISSING_INGREDIENTS', error: 'Missing ingredients' },
      outcome: { predicted_outcome_met: false },
      observationBefore: { agent: { position: { x: 0, y: 64, z: 0 } } },
      eventId: 'original-failed-step-uuid'
    }
  });

  assert.strictEqual(result.recovered, true);
  assert.strictEqual(result.correction.action, 'inspect_inventory');
  assert.strictEqual(executedActions.length, 1);
  assert.strictEqual(recordedFeedbacks.length, 1);
  assert.strictEqual(recordedFeedbacks[0].related_event_id, 'original-failed-step-uuid');
  assert.strictEqual(recordedFeedbacks[0].event_type, 'correction');
  assert.strictEqual(recordedFeedbacks[0].retry_result, 'success');

  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});

test('Safety validation cannot be bypassed by memory or feedback', () => {
  // If a corrupted or adversarial memory contains an unauthorized action
  const dangerousProposal = {
    action: 'spawn_nuke_entity',
    args: {}
  };
  const validation = validateAction(dangerousProposal.action, dangerousProposal.args);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.error.includes('Unsupported action'));
});

test('PersistentMemoryStore records task completion, stores strategy, and retrieves best strategy', () => {
  const testFile = path.join('./data/test', 'test_mem_task.json');
  const stratFile = path.join('./data/test', 'test_strat_task.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(stratFile)) fs.unlinkSync(stratFile);

  const memory = new PersistentMemoryStore({ filePath: testFile, strategiesFilePath: stratFile });

  // Initial task completion
  const res1 = memory.recordTaskCompletion({
    goalId: 'GATHER_WOOD_LOGS',
    action: 'collect_resource',
    args: { resource: 'wood', count: 3 },
    durationMs: 4000,
    preObservation: { equipment: { mainhand: null }, inventory: [] }
  });

  assert.strictEqual(res1.isNew, true);
  assert.strictEqual(res1.isImprovement, false);
  assert.strictEqual(res1.strategy.goal_id, 'GATHER_WOOD_LOGS');
  assert.strictEqual(res1.strategy.best_duration_ms, 4000);
  assert.strictEqual(res1.strategy.total_completions, 1);

  // Reload memory from disk
  const reloaded = new PersistentMemoryStore({ filePath: testFile, strategiesFilePath: stratFile });
  const bestStrat = reloaded.getBestStrategy('GATHER_WOOD_LOGS');
  assert.ok(bestStrat);
  assert.strictEqual(bestStrat.action, 'collect_resource');
  assert.strictEqual(bestStrat.args.resource, 'wood');
  assert.strictEqual(bestStrat.total_completions, 1);

  // Repeat completion with improved speed (2500ms is >=15% faster than 4000ms)
  const res2 = reloaded.recordTaskCompletion({
    goalId: 'GATHER_WOOD_LOGS',
    action: 'collect_resource',
    args: { resource: 'wood', count: 3 },
    durationMs: 2500,
    preObservation: { equipment: { mainhand: null }, inventory: [] }
  });

  assert.strictEqual(res2.isNew, false);
  assert.strictEqual(res2.isImprovement, true);
  assert.strictEqual(res2.strategy.best_duration_ms, 2500);
  assert.strictEqual(res2.strategy.improvement_history.length, 1);
  assert.ok(res2.improvementNote.includes('Faster execution'));

  // Repeat completion with upgraded tool (equipped stone_axe)
  const res3 = reloaded.recordTaskCompletion({
    goalId: 'GATHER_WOOD_LOGS',
    action: 'collect_resource',
    args: { resource: 'wood', count: 3, preferred_tool: 'stone_axe' },
    durationMs: 1800,
    preObservation: { equipment: { mainhand: { name: 'stone_axe' } }, inventory: [{ name: 'stone_axe', count: 1 }] }
  });

  assert.strictEqual(res3.isImprovement, true);
  assert.strictEqual(res3.strategy.optimal_tool, 'stone_axe');
  assert.strictEqual(res3.strategy.improvement_history.length, 2);
  assert.ok(res3.improvementNote.includes('stone_axe'));

  // Cleanup
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(stratFile)) fs.unlinkSync(stratFile);
});

test('AdaptiveThinkingEngine selects proven_memory vs improved_thinking based on inventory upgrades', async () => {
  const engine = new AdaptiveThinkingEngine();
  const testFile = path.join('./data/test', 'test_adaptive_mem.json');
  const stratFile = path.join('./data/test', 'test_adaptive_strat.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(stratFile)) fs.unlinkSync(stratFile);

  const memory = new PersistentMemoryStore({ filePath: testFile, strategiesFilePath: stratFile });

  // 1. First exploration when no strategy exists
  const plan1 = await engine.evaluateStrategy({
    goalId: 'GATHER_WOOD_LOGS',
    observation: { inventory: [], equipment: {} },
    memoryStore: memory
  });
  assert.strictEqual(plan1.mode, 'first_exploration');

  // Record initial completion with bare hands
  memory.recordTaskCompletion({
    goalId: 'GATHER_WOOD_LOGS',
    action: 'collect_resource',
    args: { resource: 'wood', count: 3 },
    durationMs: 5000,
    preObservation: { equipment: { mainhand: null }, inventory: [] }
  });

  // 2. Proven memory when inventory has no upgrades
  const plan2 = await engine.evaluateStrategy({
    goalId: 'GATHER_WOOD_LOGS',
    observation: { inventory: [], equipment: {} },
    memoryStore: memory
  });
  assert.strictEqual(plan2.mode, 'proven_memory');
  assert.strictEqual(plan2.proposedAction, 'collect_resource');

  // 3. Improved thinking when inventory now has a stone axe
  const plan3 = await engine.evaluateStrategy({
    goalId: 'GATHER_WOOD_LOGS',
    observation: {
      inventory: [{ name: 'stone_axe', count: 1 }],
      equipment: {}
    },
    memoryStore: memory
  });
  assert.strictEqual(plan3.mode, 'improved_thinking');
  assert.strictEqual(plan3.proposedArgs.preferred_tool, 'stone_axe');
  assert.ok(plan3.rationale.includes('stone_axe'));

  // 4. Batch crafting improvement when extra logs are available
  memory.recordTaskCompletion({
    goalId: 'CRAFT_PLANKS',
    action: 'craft_item',
    args: { item: 'planks', count: 1 },
    durationMs: 300,
    preObservation: { inventory: [{ name: 'oak_log', count: 1 }] }
  });

  const planPlanks = await engine.evaluateStrategy({
    goalId: 'CRAFT_PLANKS',
    observation: {
      inventory: [{ name: 'oak_log', count: 4 }]
    },
    memoryStore: memory
  });
  assert.strictEqual(planPlanks.mode, 'improved_thinking');
  assert.strictEqual(planPlanks.proposedArgs.count, 4);

  // Cleanup
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(stratFile)) fs.unlinkSync(stratFile);
});

test('AutonomousSurvivalController incorporates adaptive strategy and records task completion', async () => {
  const testFile = path.join('./data/test', 'test_auto_mem.json');
  const stratFile = path.join('./data/test', 'test_auto_strat.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(stratFile)) fs.unlinkSync(stratFile);

  const memoryStore = new PersistentMemoryStore({ filePath: testFile, strategiesFilePath: stratFile });

  const executedActions = [];
  const chatMessages = [];
  let inventory = [{ name: 'dirt', count: 12 }, { name: 'oak_log', count: 3 }];

  const mockBot = {
    isReady: true,
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 1 },
      health: 20
    },
    health: 20,
    memoryStore,
    collectObservation: () => ({
      agent: { position: { x: 0, y: 64, z: 0 }, health: 20 },
      health: 20,
      inventory: [...inventory],
      equipment: {}
    }),
    actions: {
      allowedActions: ['craft_item', 'collect_resource'],
      execute: async (spec) => {
        executedActions.push(spec);
        if (spec.action === 'craft_item' && spec.args?.item === 'planks') {
          inventory.push({ name: 'oak_planks', count: 8 });
        }
        return {
          execution: { status: 'success', duration_ms: 150 },
          outcome: { predicted_outcome_met: true }
        };
      }
    },
    chat: (msg) => chatMessages.push(msg)
  };

  const controller = new AutonomousSurvivalController();
  const stepRes = await controller.runSingleStep(mockBot);

  assert.strictEqual(stepRes.continued, false);
  assert.ok(executedActions.length > 0);

  // Verify task completion was recorded in memory store
  const savedStrategies = memoryStore.getAllStrategies();
  assert.ok(savedStrategies.length > 0);
  assert.strictEqual(savedStrategies[0].goal_id, stepRes.goalId);

  // Reset inventory to repeat the same goal and verify memory recall
  inventory = [{ name: 'dirt', count: 12 }, { name: 'oak_log', count: 3 }];
  const stepRes2 = await controller.runSingleStep(mockBot);
  assert.ok(stepRes2);
  assert.strictEqual(stepRes2.goalId, 'CRAFT_PLANKS');
  const best = memoryStore.getBestStrategy('CRAFT_PLANKS');
  assert.ok(best);
  assert.strictEqual(best.total_completions, 2);

  // Cleanup
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(stratFile)) fs.unlinkSync(stratFile);
});

