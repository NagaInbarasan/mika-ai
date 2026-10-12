import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ProgressionStateMachine } from '../src/progression/state-machine.js';
import { STAGES } from '../src/progression/stages.js';

test('ProgressionStateMachine initializes at farmer stage and checks prerequisites', () => {
  const testFile = path.join('./data/test', 'progression_test.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const psm = new ProgressionStateMachine({ storagePath: testFile });
  assert.strictEqual(psm.currentStage, STAGES.FARMER);

  // Initial empty observation should fail prerequisites to advance
  const emptyObs = { inventory: [], equipment: {} };
  const eval1 = psm.evaluateAdvancement(emptyObs);
  assert.strictEqual(eval1.canAdvance, false);
  assert.strictEqual(eval1.nextStage, STAGES.WARRIOR);
  assert.strictEqual(eval1.prerequisites.length, 3);
  assert.strictEqual(eval1.prerequisites.every(p => !p.met), true);

  // Attempting advance should fail
  const advFail = psm.advanceStage(emptyObs);
  assert.strictEqual(advFail.success, false);
  assert.strictEqual(psm.currentStage, STAGES.FARMER);

  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});

test('ProgressionStateMachine promotes to Warrior stage when prerequisites are satisfied', () => {
  const testFile = path.join('./data/test', 'progression_advance.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const psm = new ProgressionStateMachine({ storagePath: testFile });

  // Observation satisfying all Farmer -> Warrior prerequisites:
  // 1. Food reserve >= 16
  // 2. Full tools (pickaxe, axe, sword)
  // 3. Shield or armor
  const qualifiedObs = {
    inventory: [
      { name: 'bread', count: 16 },
      { name: 'iron_pickaxe', count: 1 },
      { name: 'iron_axe', count: 1 },
      { name: 'iron_sword', count: 1 },
      { name: 'shield', count: 1 }
    ],
    equipment: {
      offhand: { name: 'shield' }
    }
  };

  const evalResult = psm.evaluateAdvancement(qualifiedObs);
  assert.strictEqual(evalResult.canAdvance, true);
  assert.strictEqual(evalResult.prerequisites.every(p => p.met), true);

  const advSuccess = psm.advanceStage(qualifiedObs);
  assert.strictEqual(advSuccess.success, true);
  assert.strictEqual(advSuccess.previousStage, STAGES.FARMER);
  assert.strictEqual(advSuccess.currentStage, STAGES.WARRIOR);
  assert.strictEqual(psm.currentStage, STAGES.WARRIOR);

  // Reload from file to verify persistence
  const reloaded = new ProgressionStateMachine({ storagePath: testFile });
  assert.strictEqual(reloaded.currentStage, STAGES.WARRIOR);
  assert.strictEqual(reloaded.history.length, 1);
  assert.strictEqual(reloaded.history[0].to_stage, STAGES.WARRIOR);

  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});

test('ProgressionStateMachine tracks mob kills, damage, and deaths', () => {
  const testFile = path.join('./data/test', 'progression_stats.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const psm = new ProgressionStateMachine({ storagePath: testFile });

  psm.recordKill('zombie', 8);
  psm.recordKill('skeleton', 10);
  psm.recordDamageTaken(4);
  psm.recordDeath();

  assert.strictEqual(psm.stats.mobs_killed_total, 2);
  assert.strictEqual(psm.stats.mobs_killed_by_type.zombie, 1);
  assert.strictEqual(psm.stats.mobs_killed_by_type.skeleton, 1);
  assert.strictEqual(psm.stats.damage_dealt_total, 18);
  assert.strictEqual(psm.stats.damage_taken_total, 4);
  assert.strictEqual(psm.stats.deaths_total, 1);

  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});
