import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ProblemDetector,
  PROBLEM_TYPES,
  SEVERITY,
  EMPIRICAL_THRESHOLDS
} from '../src/diagnostics/problem-detector.js';
import {
  ProblemDiagnostician,
  ROOT_CAUSE_CATEGORIES
} from '../src/diagnostics/problem-diagnostician.js';
import { ResolutionPlanner } from '../src/diagnostics/resolution-planner.js';
import { RecoveryExecutor } from '../src/diagnostics/recovery-executor.js';
import { ProblemSolver } from '../src/diagnostics/problem-solver.js';

test('ProblemDetector: Detects CRITICAL_VITALS using real Minecraft error parameters', () => {
  const detector = new ProblemDetector();

  // Test actual Minecraft failure from experiences.jsonl: health 5.33
  const detected = detector.detectProblem({
    bot: { health: 5.33, food: 14 },
    action: 'collect_resource',
    args: { resource: 'dirt' },
    execution: {
      status: 'failed',
      duration_ms: 0,
      error: 'Health critical (5.333334922790527/20), aborted resource collection to survive',
      error_code: 'UNKNOWN_ERROR'
    },
    currentGoal: 'GATHER_SHELTER_BLOCKS'
  });

  assert.strictEqual(detected.hasProblem, true);
  assert.strictEqual(detected.problemType, PROBLEM_TYPES.CRITICAL_VITALS);
  assert.strictEqual(detected.severity, SEVERITY.CRITICAL);
  assert.ok(detected.evidence.includes('Health is critical'));
});

test('ProblemDetector: Detects RESOURCE_NOT_FOUND (sweet_berries loop prevention)', () => {
  const detector = new ProblemDetector();

  const detected = detector.detectProblem({
    bot: { health: 20, food: 20 },
    action: 'collect_resource',
    args: { resource: 'sweet_berries' },
    execution: {
      status: 'failed',
      error: "No block of type 'sweet_berries' found within 32 blocks",
      error_code: 'RESOURCE_NOT_FOUND'
    },
    currentGoal: 'GATHER_FOOD'
  });

  assert.strictEqual(detected.hasProblem, true);
  assert.strictEqual(detected.problemType, PROBLEM_TYPES.RESOURCE_NOT_FOUND);
  assert.strictEqual(detected.severity, SEVERITY.HIGH);
});

test('ProblemDetector: Detects CRAFTING_BLOCKED on 3x3 table requirement', () => {
  const detector = new ProblemDetector();

  const detected = detector.detectProblem({
    bot: { health: 20, food: 20 },
    action: 'craft_item',
    args: { item: 'wooden_pickaxe' },
    execution: {
      status: 'failed',
      error: "Crafting 'wooden_pickaxe' requires a crafting table",
      error_code: 'CRAFTING_TABLE_REQUIRED'
    },
    currentGoal: 'CRAFT_WOODEN_PICKAXE'
  });

  assert.strictEqual(detected.hasProblem, true);
  assert.strictEqual(detected.problemType, PROBLEM_TYPES.CRAFTING_BLOCKED);
});

test('ProblemDetector: Detects BLOCK_PLACEMENT_FAILED on server refusal', () => {
  const detector = new ProblemDetector();

  const detected = detector.detectProblem({
    bot: { health: 20, food: 20 },
    action: 'place_block',
    args: { block: 'dirt', x: -366, y: 68, z: -368 },
    execution: {
      status: 'failed',
      error: "Server refused to place dirt at (-366, 68, -368): the block cannot be placed here",
      error_code: 'PLACE_BLOCK_ERROR'
    },
    currentGoal: 'BUILD_EMERGENCY_SHELTER'
  });

  assert.strictEqual(detected.hasProblem, true);
  assert.strictEqual(detected.problemType, PROBLEM_TYPES.BLOCK_PLACEMENT_FAILED);
});

test('ProblemDetector: Detects TASK_STAGNATION on repeated failures', () => {
  const detector = new ProblemDetector({ MAX_RETRY_STAGNATION: 2 });

  // First failure
  detector.detectProblem({
    bot: { health: 20, food: 20 },
    action: 'collect_resource',
    execution: { status: 'failed', error: 'Fail 1' },
    currentGoal: 'GATHER_WOOD_LOGS'
  });

  // Second failure -> Triggers stagnation
  const second = detector.detectProblem({
    bot: { health: 20, food: 20 },
    action: 'collect_resource',
    execution: { status: 'failed', error: 'Fail 2' },
    currentGoal: 'GATHER_WOOD_LOGS'
  });

  assert.strictEqual(second.hasProblem, true);
  assert.strictEqual(second.problemType, PROBLEM_TYPES.TASK_STAGNATION);
  assert.strictEqual(second.severity, SEVERITY.HIGH);
});

test('ProblemDiagnostician: Accurately classifies root cause and isolates factors', () => {
  const diagnostician = new ProblemDiagnostician();

  const diagnosis = diagnostician.diagnose({
    problem: {
      hasProblem: true,
      problemType: PROBLEM_TYPES.CRITICAL_VITALS,
      severity: SEVERITY.CRITICAL,
      evidence: 'Health is critical (5.3/20)'
    },
    bot: {
      health: 5.3,
      food: 14,
      inventory: {
        items: () => [{ name: 'bread', count: 3 }]
      }
    },
    currentTask: 'GATHER_SHELTER_BLOCKS'
  });

  assert.strictEqual(diagnosis.hasDiagnosis, true);
  assert.strictEqual(diagnosis.category, ROOT_CAUSE_CATEGORIES.CRITICAL_HEALTH_OR_HUNGER);
  assert.strictEqual(diagnosis.recommendedActionType, 'EAT_FOOD');
  assert.ok(diagnosis.confidence >= 0.95);
  assert.ok(diagnosis.contributingFactors.some(f => f.includes('Edible food available')));
});

test('ResolutionPlanner: Plans ranked recovery solutions for vitals and resources', () => {
  const planner = new ResolutionPlanner();

  // Test plans for critical vitals with food in inventory
  const vitalsPlans = planner.generateResolutionPlans({
    diagnosis: {
      hasDiagnosis: true,
      category: ROOT_CAUSE_CATEGORIES.CRITICAL_HEALTH_OR_HUNGER
    },
    bot: {
      health: 5.3,
      food: 14,
      inventory: {
        items: () => [{ name: 'bread', count: 3 }]
      }
    }
  });

  assert.ok(vitalsPlans.length >= 2);
  assert.strictEqual(vitalsPlans[0].action, 'eat_food');
  assert.strictEqual(vitalsPlans[0].args.item, 'bread');
  assert.strictEqual(vitalsPlans[1].action, 'retreat_and_heal');

  // Test plans for absent resource (sweet_berries substitution)
  const resourcePlans = planner.generateResolutionPlans({
    diagnosis: {
      hasDiagnosis: true,
      category: ROOT_CAUSE_CATEGORIES.RESOURCE_DEPLETED_OR_ABSENT
    },
    bot: {
      health: 20,
      inventory: { items: () => [] }
    }
  });

  assert.ok(resourcePlans.length >= 2);
  assert.strictEqual(resourcePlans[0].action, 'collect_resource');
  assert.strictEqual(resourcePlans[0].args.resource, 'dirt');
});

test('RecoveryExecutor: Executes candidate plan and verifies recovery outcome', async () => {
  const executor = new RecoveryExecutor();

  let executedAction = null;
  const mockBot = {
    actions: {
      execute: async ({ action, args }) => {
        executedAction = action;
        return { execution: { status: 'success' } };
      }
    }
  };

  const candidatePlans = [
    {
      id: 'plan_eat_food',
      action: 'eat_food',
      args: { item: 'bread' },
      strategy: 'Eat bread'
    }
  ];

  const result = await executor.executeRecovery({
    bot: mockBot,
    resolutionPlans: candidatePlans,
    diagnosis: { category: ROOT_CAUSE_CATEGORIES.CRITICAL_HEALTH_OR_HUNGER }
  });

  assert.strictEqual(result.recovered, true);
  assert.strictEqual(executedAction, 'eat_food');
  assert.strictEqual(result.successfulPlan.id, 'plan_eat_food');
});

test('ProblemSolver: End-to-end resolution of Minecraft critical health failure', async () => {
  const testLogDir = path.join(process.cwd(), 'data', 'test');
  fs.mkdirSync(testLogDir, { recursive: true });
  const testLogPath = path.join(testLogDir, `diagnostics-test-${Date.now()}.json`);
  if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);

  const solver = new ProblemSolver({ diagnosticsLogPath: testLogPath });

  let actionExecuted = null;
  const mockBot = {
    health: 5.33,
    food: 14,
    inventory: {
      items: () => [{ name: 'bread', count: 2 }]
    },
    actions: {
      execute: async ({ action, args }) => {
        actionExecuted = action;
        return { execution: { status: 'success' } };
      }
    }
  };

  // Feed the real failure parameters from experiences.jsonl
  const result = await solver.handleProblem({
    bot: mockBot,
    action: 'collect_resource',
    args: { resource: 'dirt' },
    execution: {
      status: 'failed',
      error: 'Health critical (5.333334922790527/20), aborted resource collection to survive'
    },
    currentGoal: 'GATHER_SHELTER_BLOCKS'
  });

  assert.strictEqual(result.hasProblem, true);
  assert.strictEqual(result.resolved, true);
  assert.strictEqual(result.problem.problemType, PROBLEM_TYPES.CRITICAL_VITALS);
  assert.strictEqual(result.diagnosis.category, ROOT_CAUSE_CATEGORIES.CRITICAL_HEALTH_OR_HUNGER);
  assert.strictEqual(actionExecuted, 'eat_food');

  const summary = solver.getSummary();
  assert.strictEqual(summary.problemsDetected, 1);
  assert.strictEqual(summary.problemsResolved, 1);
  assert.strictEqual(summary.resolutionRate, '100%');

  if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);
});
