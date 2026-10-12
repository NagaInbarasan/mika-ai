import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ExperienceRecorder } from '../src/data/recorder.js';
import { collectObservation } from '../src/minecraft/observe.js';

test('collectObservation returns structured state from bot mock', () => {
  const mockBot = {
    entity: {
      position: { x: 12.34, y: 64.0, z: -45.67 },
      yaw: 1.57,
      pitch: 0.0
    },
    health: 18.5,
    food: 20,
    foodSaturation: 5.0,
    oxygenLevel: 20,
    game: {
      dimension: 'overworld',
      gameMode: 'survival'
    },
    time: {
      timeOfDay: 6000
    },
    isRaining: false,
    inventory: {
      items: () => [{ name: 'oak_log', count: 4, slot: 36 }]
    },
    entities: {
      '1': {
        name: 'zombie',
        type: 'mob',
        position: { x: 15.0, y: 64.0, z: -40.0 }
      }
    },
    findBlocks: () => []
  };
  mockBot.entity.position.distanceTo = (other) => {
    const dx = 12.34 - other.x;
    const dy = 64.0 - other.y;
    const dz = -45.67 - other.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  const obs = collectObservation(mockBot);
  assert.ok(obs.agent, 'Should include agent state');
  assert.strictEqual(obs.agent.position.x, 12.3);
  assert.strictEqual(obs.agent.health, 18.5);
  assert.strictEqual(obs.environment.dimension, 'overworld');
  assert.strictEqual(obs.environment.isDay, true);
  assert.strictEqual(obs.inventory.length, 1);
  assert.strictEqual(obs.inventory[0].name, 'oak_log');
  assert.strictEqual(obs.nearby_threats.length, 1);
  assert.strictEqual(obs.nearby_threats[0].name, 'zombie');
});

test('ExperienceRecorder writes valid JSONL adhering to schema', () => {
  const tmpExp = path.join('./data/test', 'test_experiences.jsonl');
  const tmpFb = path.join('./data/test', 'test_feedback.jsonl');

  if (fs.existsSync(tmpExp)) fs.unlinkSync(tmpExp);
  if (fs.existsSync(tmpFb)) fs.unlinkSync(tmpFb);

  const recorder = new ExperienceRecorder({
    runId: 'test-run-1',
    episodeId: 'test-ep-1',
    experiencesPath: tmpExp,
    feedbackPath: tmpFb
  });

  const event = recorder.recordExperience({
    minecraft_version: '1.21',
    observation_before: { position: { x: 0, y: 64, z: 0 }, health: 20 },
    goal: 'test goal',
    available_actions: ['observe', 'look_around']
  });

  assert.strictEqual(event.schema_version, '1.0');
  assert.strictEqual(event.step, 1);
  assert.strictEqual(event.run_id, 'test-run-1');
  assert.ok(event.event_id);

  // Validate written file
  const content = fs.readFileSync(tmpExp, 'utf-8').trim();
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.step, 1);
  assert.strictEqual(parsed.goal, 'test goal');

  // Test feedback recording
  const fbEvent = recorder.recordFeedback({
    label: 'positive',
    feedback_text: 'Good job!'
  });
  assert.strictEqual(fbEvent.label, 'positive');

  const fbContent = fs.readFileSync(tmpFb, 'utf-8').trim();
  const fbParsed = JSON.parse(fbContent);
  assert.strictEqual(fbParsed.feedback_text, 'Good job!');

  // Cleanup
  fs.unlinkSync(tmpExp);
  fs.unlinkSync(tmpFb);
});
