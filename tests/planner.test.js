import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../src/planner/action-schema.js';
import { buildReasoningContext } from '../src/planner/context.js';
import { HighLevelPlanner } from '../src/planner/planner.js';

test('validateDecision validates structured Qwen decisions', () => {
  const validDecision = {
    goal: 'collect sand for shelter',
    reason_summary: 'Sand is abundant in the desert and easily harvested.',
    action: 'collect_resource',
    arguments: { resource: 'sand' },
    expected_outcome: 'inventory contains additional sand',
    risk: 'low',
    confidence: 0.85
  };

  const result = validateDecision(validDecision);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.decision.action, 'collect_resource');
  assert.strictEqual(result.decision.arguments.resource, 'sand');
});

test('validateDecision rejects unsupported actions and malformed output', () => {
  // Unsupported action
  const badAction = {
    goal: 'do something forbidden',
    reason_summary: 'testing exploit',
    action: 'execute_shell_command',
    arguments: { command: 'rm -rf /' },
    expected_outcome: 'chaos',
    risk: 'high'
  };
  const badActionResult = validateDecision(badAction);
  assert.strictEqual(badActionResult.valid, false);
  assert.ok(badActionResult.error.includes('Action must be one of'));

  // Missing arguments for navigate_to
  const missingArgs = {
    goal: 'walk somewhere',
    reason_summary: 'exploring',
    action: 'navigate_to',
    arguments: {},
    expected_outcome: 'reaches spot',
    risk: 'low'
  };
  const missingArgsResult = validateDecision(missingArgs);
  assert.strictEqual(missingArgsResult.valid, false);
  assert.ok(missingArgsResult.error.includes('navigate_to'));

  // Non-object input
  assert.strictEqual(validateDecision('not an object').valid, false);
  assert.strictEqual(validateDecision(null).valid, false);
});

test('buildReasoningContext constructs compact bounded context', () => {
  const mockObs = {
    agent: {
      position: { x: 10.5, y: 64, z: -20.5 },
      health: 18,
      food: 19
    },
    environment: { isDay: true, dimension: 'overworld' },
    inventory: [{ name: 'sand', count: 12 }],
    nearby_threats: [{ name: 'husk', distance: 14 }],
    nearby_resources: [{ name: 'cactus', distance: 6, position: { x: 12, y: 64, z: -18 } }]
  };

  const ctx = buildReasoningContext({
    observation: mockObs,
    goal: 'gather cactus'
  });

  assert.strictEqual(ctx.current_goal, 'gather cactus');
  assert.strictEqual(ctx.agent_state.health, '18/20');
  assert.strictEqual(ctx.inventory.length, 1);
  assert.strictEqual(ctx.inventory[0], 'sand x12');
  assert.strictEqual(ctx.nearby_threats[0], 'husk (14m away)');
  assert.ok(Array.isArray(ctx.allowed_actions));
  assert.ok(ctx.allowed_actions.includes('collect_resource'));
});

test('HighLevelPlanner prioritizes immediate threats reactively', () => {
  const planner = new HighLevelPlanner();
  const dangerousObs = {
    agent: {
      position: { x: 0, y: 64, z: 0 },
      health: 6 // Critical low health
    },
    nearby_threats: [
      { name: 'husk', distance: 3.2, position: { x: 2, y: 64, z: 2 } }
    ]
  };

  const reactive = planner.checkImmediateThreats(dangerousObs);
  assert.ok(reactive, 'Should trigger immediate reactive safety override');
  assert.strictEqual(reactive.action, 'navigate_to');
  assert.strictEqual(reactive.risk, 'high');
  assert.ok(reactive.reason_summary.includes('husk'));
});

test('HighLevelPlanner falls back to safe stop when LLM fails or times out', async () => {
  // Mock failing LLM client
  const mockFailingClient = {
    chatJSON: async () => ({ success: false, error: 'Connection refused or timeout' })
  };

  const planner = new HighLevelPlanner({ llmClient: mockFailingClient });
  const safeObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20 },
    nearby_threats: []
  };

  const result = await planner.planNextStep({ observation: safeObs });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.source, 'fallback');
  assert.strictEqual(result.decision.action, 'stop');
  assert.ok(result.decision.reason_summary.includes('unavailable or rejected'));
});

test('HighLevelPlanner successfully validates mock Qwen response', async () => {
  const mockWorkingClient = {
    chatJSON: async () => ({
      success: true,
      content: {
        goal: 'gather sand in desert',
        reason_summary: 'Sand is nearby and needed for glass or building blocks.',
        action: 'collect_resource',
        arguments: { resource: 'sand' },
        expected_outcome: 'inventory sand increases',
        risk: 'low',
        confidence: 0.9
      },
      latencyMs: 120
    })
  };

  const planner = new HighLevelPlanner({ llmClient: mockWorkingClient });
  const obs = {
    agent: { position: { x: 5, y: 64, z: 5 }, health: 20 },
    nearby_threats: []
  };

  const result = await planner.planNextStep({ observation: obs, goal: 'gather materials' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.source, 'qwen');
  assert.strictEqual(result.decision.action, 'collect_resource');
  assert.strictEqual(result.decision.arguments.resource, 'sand');
});
