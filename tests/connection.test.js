import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config/index.js';
import { createBotConnection, disconnectBot } from '../src/minecraft/connect.js';

test('Configuration validation', () => {
  assert.ok(config.minecraft.host, 'Minecraft host must be defined');
  assert.ok(config.minecraft.port > 0, 'Minecraft port must be a positive integer');
  assert.strictEqual(config.minecraft.username, 'MIKA_Bot');
  assert.strictEqual(config.ollama.model, 'qwen3.5:9b');
  assert.strictEqual(config.ollama.host, 'http://localhost:11434');
});

test('Minecraft connect module exports', () => {
  assert.strictEqual(typeof createBotConnection, 'function');
  assert.strictEqual(typeof disconnectBot, 'function');
});

test('Goal normalization and canonical goal IDs', async () => {
  const { normalizeGoalId, GOAL_DEFINITIONS } = await import('../src/learning/goals.js');
  assert.strictEqual(normalizeGoalId('shelter'), 'BUILD_EMERGENCY_SHELTER');
  assert.strictEqual(normalizeGoalId('wood'), 'GATHER_WOOD_LOGS');
  assert.strictEqual(normalizeGoalId('pickaxe'), 'CRAFT_WOODEN_PICKAXE');
  assert.strictEqual(normalizeGoalId('stone'), 'MINE_STONE');
  assert.strictEqual(normalizeGoalId('tools'), 'CRAFT_STONE_TOOLS');
  assert.strictEqual(normalizeGoalId('BUILD_EMERGENCY_SHELTER'), 'BUILD_EMERGENCY_SHELTER');
  assert.ok(GOAL_DEFINITIONS.BUILD_EMERGENCY_SHELTER);
  assert.ok(GOAL_DEFINITIONS.CRAFT_STONE_TOOLS);
});
