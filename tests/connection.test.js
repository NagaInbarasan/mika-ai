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
