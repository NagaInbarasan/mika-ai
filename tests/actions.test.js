import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_ACTIONS, validateAction, ActionExecutor } from '../src/actions/index.js';
import { evaluateOutcome } from '../src/evaluation/outcome.js';
import { executeLookAround } from '../src/actions/look.js';
import { executeInspectInventory } from '../src/actions/inventory.js';
import { executeEatFood } from '../src/actions/food.js';
import { executeCraftItem } from '../src/actions/crafting.js';
import { executeCollectResource } from '../src/actions/resources.js';

test('validateAction enforces strict allowlist and required arguments', () => {
  // Allowlisted actions
  assert.strictEqual(validateAction('look_around').valid, true);
  assert.strictEqual(validateAction('inspect_inventory').valid, true);
  assert.strictEqual(validateAction('stop').valid, true);
  assert.strictEqual(validateAction('navigate_to', { x: 10, z: 20 }).valid, true);
  assert.strictEqual(validateAction('collect_resource', { resource: 'oak_log' }).valid, true);
  assert.strictEqual(validateAction('craft_item', { item: 'stick' }).valid, true);

  // Rejected invalid actions
  assert.strictEqual(validateAction('run_arbitrary_code').valid, false);
  assert.strictEqual(validateAction('kill_all_players').valid, false);
  assert.strictEqual(validateAction('drop_nuke').valid, false);

  // Rejected missing arguments
  assert.strictEqual(validateAction('navigate_to', {}).valid, false);
  assert.strictEqual(validateAction('collect_resource', {}).valid, false);
  assert.strictEqual(validateAction('craft_item', {}).valid, false);
});

test('look_around rotates bot gaze', async () => {
  const mockBot = {
    entity: { yaw: 0, pitch: 0 },
    look: async (y, p) => {
      mockBot.entity.yaw = y;
      mockBot.entity.pitch = p;
    }
  };

  const result = await executeLookAround(mockBot, { yaw: 1.57, pitch: 0.5 });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data.final_yaw, 1.57);
  assert.strictEqual(result.data.final_pitch, 0.5);
});

test('inspect_inventory summarizes item counts and empty slots', async () => {
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'oak_log', count: 3, slot: 36 },
        { name: 'apple', count: 2, slot: 37 }
      ],
      emptySlotCount: () => 34
    }
  };

  const result = await executeInspectInventory(mockBot);
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data.unique_items, 2);
  assert.strictEqual(result.data.total_items, 5);
  assert.strictEqual(result.data.empty_slots, 34);
});

test('eat_food handles not-hungry and missing-food preconditions', async () => {
  // Precondition: Not hungry (food = 20)
  const fullBot = {
    food: 20,
    inventory: { items: () => [{ name: 'bread', count: 1 }] }
  };
  const fullResult = await executeEatFood(fullBot);
  assert.strictEqual(fullResult.status, 'failed');
  assert.strictEqual(fullResult.error_code, 'NOT_HUNGRY');

  // Precondition: Hungry but no food in inventory
  const hungryBot = {
    food: 14,
    inventory: { items: () => [{ name: 'dirt', count: 10 }] }
  };
  const noFoodResult = await executeEatFood(hungryBot);
  assert.strictEqual(noFoodResult.status, 'failed');
  assert.strictEqual(noFoodResult.error_code, 'NO_FOOD_AVAILABLE');
});

test('craft_item detects missing ingredients cleanly', async () => {
  const mockBot = {
    inventory: { items: () => [] },
    registry: { itemsByName: { stick: { id: 280, name: 'stick' } } },
    findBlock: () => null,
    recipesFor: () => [],
    recipesAll: () => [{ result: { count: 4 } }]
  };

  const result = await executeCraftItem(mockBot, { item: 'stick' });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error_code, 'MISSING_INGREDIENTS');
});

test('collect_resource handles resource not found', async () => {
  const mockBot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    findBlock: () => null
  };

  const result = await executeCollectResource(mockBot, { resource: 'diamond_ore' });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error_code, 'RESOURCE_NOT_FOUND');
});

test('evaluateOutcome measures deltas accurately', () => {
  const preObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 18, isAlive: true },
    inventory: [{ name: 'oak_log', count: 2 }]
  };
  const postObs = {
    agent: { position: { x: 5, y: 64, z: 0 }, health: 18, food: 18, isAlive: true },
    inventory: [{ name: 'oak_log', count: 3 }]
  };

  const outcome = evaluateOutcome({
    preObservation: preObs,
    postObservation: postObs,
    action: 'collect_resource',
    args: { resource: 'oak_log' },
    expectedOutcome: 'inventory oak_log count increases',
    executionResult: { status: 'success', duration_ms: 1500 }
  });

  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.position_delta.dx, 5);
  assert.strictEqual(outcome.position_delta.distance_moved, 5);
  assert.strictEqual(outcome.health_delta, -2);
  assert.strictEqual(outcome.damage_taken, 2);
  assert.strictEqual(outcome.food_delta, 0);
  assert.strictEqual(outcome.resource_delta.oak_log, 1);
  assert.strictEqual(outcome.predicted_outcome_met, true);
  assert.strictEqual(outcome.task_progress, 1);
});

test('ActionExecutor executes and logs experience', async () => {
  const recordedLogs = [];
  const mockBot = {
    version: '1.21.11',
    entity: {
      position: { x: 10, y: 64, z: 10, distanceTo: () => 0 },
      yaw: 0,
      pitch: 0
    },
    health: 20,
    food: 20,
    inventory: {
      items: () => [{ name: 'apple', count: 1, slot: 36 }],
      emptySlotCount: () => 35
    },
    look: async () => {},
    recorder: {
      recordExperience: (rec) => recordedLogs.push(rec)
    }
  };

  const executor = new ActionExecutor(mockBot);
  const result = await executor.execute({
    action: 'inspect_inventory',
    goal: 'check starting items'
  });

  assert.strictEqual(result.execution.status, 'success');
  assert.strictEqual(result.outcome.predicted_outcome_met, true);
  assert.strictEqual(recordedLogs.length, 1);
  assert.strictEqual(recordedLogs[0].goal, 'check starting items');
  assert.strictEqual(recordedLogs[0].decision.action, 'inspect_inventory');
});
