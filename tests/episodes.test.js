import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ScriptedBaselinePlanner } from '../src/episodes/baseline.js';
import { EpisodeManager } from '../src/episodes/runner.js';

test('ScriptedBaselinePlanner proposes heuristic actions for all supported tasks', () => {
  const baseline = new ScriptedBaselinePlanner();

  // 1. Gather resource with resource visible
  const obsWithSand = {
    agent: { position: { x: 0, y: 64, z: 0 }, yaw: 0 },
    nearby_resources: [{ name: 'sand', distance: 3.2 }]
  };
  const gatherAction = baseline.proposeAction({
    observation: obsWithSand,
    taskType: 'gather_resource',
    taskTarget: { resource: 'sand', count: 2 }
  });
  assert.strictEqual(gatherAction.action, 'collect_resource');
  assert.strictEqual(gatherAction.arguments.resource, 'sand');

  // 2. Gather resource without resource visible -> rotates gaze
  const obsWithoutSand = {
    agent: { position: { x: 0, y: 64, z: 0 }, yaw: 0 },
    nearby_resources: []
  };
  const lookAction = baseline.proposeAction({
    observation: obsWithoutSand,
    taskType: 'gather_resource',
    taskTarget: { resource: 'sand', count: 2 }
  });
  assert.strictEqual(lookAction.action, 'look_around');

  // 3. Navigate and return
  const navAction = baseline.proposeAction({
    observation: obsWithSand,
    taskType: 'navigate_and_return',
    taskTarget: { destination: { x: 10, y: 64, z: 10 } }
  });
  assert.strictEqual(navAction.action, 'navigate_to');
  assert.strictEqual(navAction.arguments.x, 10);

  // 4. Hazard avoidance with nearby threat -> retreats
  const obsWithThreat = {
    agent: { position: { x: 0, y: 64, z: 0 } },
    nearby_threats: [{ name: 'husk', distance: 4.5, position: { x: 4, y: 64, z: 0 } }]
  };
  const retreatAction = baseline.proposeAction({
    observation: obsWithThreat,
    taskType: 'hazard_avoidance'
  });
  assert.strictEqual(retreatAction.action, 'navigate_to');
  assert.ok(retreatAction.arguments.x < 0, 'Retreat should move away from positive x coordinate of husk');

  // 5. Hazard avoidance without threats -> safe stop
  const safeAction = baseline.proposeAction({
    observation: obsWithSand,
    taskType: 'hazard_avoidance'
  });
  assert.strictEqual(safeAction.action, 'stop');
});

test('EpisodeManager runs baseline gather episode to goal_completed', async () => {
  const testReportsDir = path.join('./data/test', 'reports');
  const episodesLog = path.join(testReportsDir, 'episodes.jsonl');
  if (fs.existsSync(episodesLog)) fs.unlinkSync(episodesLog);

  const manager = new EpisodeManager({ reportsDir: testReportsDir, stepDelayMs: 0 });

  let stepCallCount = 0;
  let sandInInv = 0;

  const mockBot = {
    isReady: true,
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 20,
    collectObservation: () => ({
      agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
      inventory: [{ name: 'sand', count: sandInInv }],
      nearby_resources: [{ name: 'sand', distance: 2.0 }]
    }),
    actions: {
      execute: async (plan) => {
        stepCallCount++;
        if (plan.action === 'collect_resource') {
          sandInInv += 1; // collect 1 sand per step
        }
        return {
          execution: { status: 'success', duration_ms: 50 },
          outcome: { damage_taken: 0, task_progress: 1 }
        };
      }
    },
    chat: () => {}
  };

  const result = await manager.runEpisode({
    bot: mockBot,
    taskType: 'gather_resource',
    taskTarget: { resource: 'sand', count: 2 },
    strategy: 'baseline',
    maxSteps: 5
  });

  assert.strictEqual(result.completion_status, 'success');
  assert.strictEqual(result.termination_reason, 'goal_completed');
  assert.strictEqual(result.metrics.resource_delta.sand, 2);
  assert.strictEqual(result.metrics.total_steps, 2);
  assert.strictEqual(result.metrics.failed_actions, 0);

  // Check persisted JSONL record
  assert.ok(fs.existsSync(episodesLog));
  const lines = fs.readFileSync(episodesLog, 'utf-8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const loggedEp = JSON.parse(lines[0]);
  assert.strictEqual(loggedEp.episode_id, result.episode_id);
  assert.strictEqual(loggedEp.completion_status, 'success');

  // Clean up
  if (fs.existsSync(episodesLog)) fs.unlinkSync(episodesLog);
});

test('EpisodeManager enforces maxSteps budget and terminates with step_budget_exhausted', async () => {
  const testReportsDir = path.join('./data/test', 'reports_budget');
  const episodesLog = path.join(testReportsDir, 'episodes.jsonl');
  if (fs.existsSync(episodesLog)) fs.unlinkSync(episodesLog);

  const manager = new EpisodeManager({ reportsDir: testReportsDir, stepDelayMs: 0 });

  let stepCount = 0;
  const mockBot = {
    isReady: true,
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 20,
    collectObservation: () => ({
      agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
      inventory: [],
      nearby_resources: [] // No resources available
    }),
    actions: {
      execute: async () => {
        stepCount++;
        return {
          execution: { status: 'success', duration_ms: 10 },
          outcome: { damage_taken: 0, task_progress: 0 }
        };
      }
    },
    chat: () => {}
  };

  const maxStepsBudget = 3;
  const result = await manager.runEpisode({
    bot: mockBot,
    taskType: 'gather_resource',
    taskTarget: { resource: 'sand', count: 5 },
    strategy: 'baseline',
    maxSteps: maxStepsBudget
  });

  assert.strictEqual(result.completion_status, 'failure');
  assert.strictEqual(result.termination_reason, 'step_budget_exhausted');
  assert.strictEqual(result.metrics.total_steps, maxStepsBudget);
  assert.strictEqual(stepCount, maxStepsBudget);

  if (fs.existsSync(episodesLog)) fs.unlinkSync(episodesLog);
});

test('EpisodeManager supports Qwen planner strategy and records inference metrics', async () => {
  const testReportsDir = path.join('./data/test', 'reports_qwen');
  const episodesLog = path.join(testReportsDir, 'episodes.jsonl');
  if (fs.existsSync(episodesLog)) fs.unlinkSync(episodesLog);

  const manager = new EpisodeManager({ reportsDir: testReportsDir, stepDelayMs: 0 });

  let qwenCalls = 0;
  const mockBot = {
    isReady: true,
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 20,
    collectObservation: () => ({
      agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
      inventory: [],
      nearby_threats: []
    }),
    planner: {
      planNextStep: async () => {
        qwenCalls++;
        return {
          decision: {
            goal: 'retreat to safety',
            action: 'stop',
            arguments: {},
            expected_outcome: 'remain safe'
          },
          latencyMs: 120
        };
      }
    },
    actions: {
      execute: async () => ({
        execution: { status: 'success', duration_ms: 20 },
        outcome: { damage_taken: 0, task_progress: 1 }
      })
    },
    chat: () => {}
  };

  const result = await manager.runEpisode({
    bot: mockBot,
    taskType: 'hazard_avoidance',
    strategy: 'qwen',
    maxSteps: 2
  });

  // Since nearby_threats is empty, hazard_avoidance terminates with success immediately
  assert.strictEqual(result.completion_status, 'success');
  assert.strictEqual(result.termination_reason, 'goal_completed');

  if (fs.existsSync(episodesLog)) fs.unlinkSync(episodesLog);
});
