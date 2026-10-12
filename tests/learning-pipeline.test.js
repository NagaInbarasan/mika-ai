import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  validateAndNormalizeRecord,
  parseJsonlFile,
  linkFeedbackRecords,
  detectLabelAnomalies,
  generateSpecializedDatasets,
  splitByEpisode,
  getEpisodeKey
} from '../src/data/preprocess.js';
import { PersistentMemoryStore } from '../src/learning/memory.js';
import { RecoveryManager } from '../src/learning/recovery.js';

test('Pipeline Data Cleaning: detects contradictory and missing labels correctly', () => {
  const experiences = [
    {
      event_id: 'ev-1',
      run_id: 'run-1',
      episode_id: 'ep-1',
      step: 1,
      decision: { action: 'craft_item', arguments: { item: 'stick' } },
      execution: { status: 'failed', error_code: 'MISSING_INGREDIENTS' },
      outcome: { reward: -0.5, task_progress: 0 },
      learning: { failure_detected: true, feedback_records: [] }
    },
    {
      event_id: 'ev-2',
      run_id: 'run-1',
      episode_id: 'ep-1',
      step: 2,
      decision: { action: 'collect_resource', arguments: { resource: 'wood' } },
      execution: { status: 'success' },
      outcome: { reward: 1.0, task_progress: 1 },
      learning: { failure_detected: false, feedback_records: [] }
    }
  ];

  const feedbackRecords = [
    // Contradiction: failed execution marked positive
    {
      event_id: 'fb-1',
      related_event_id: 'ev-1',
      event_type: 'user_feedback',
      label: 'positive',
      feedback_text: 'Good job'
    },
    // Contradiction: successful execution marked negative
    {
      event_id: 'fb-2',
      related_event_id: 'ev-2',
      event_type: 'user_feedback',
      label: 'negative',
      feedback_text: 'Wrong priority'
    },
    // Missing label
    {
      event_id: 'fb-3',
      related_event_id: 'ev-2',
      event_type: 'user_feedback',
      label: null,
      feedback_text: 'Unlabeled note'
    }
  ];

  linkFeedbackRecords(experiences, feedbackRecords);
  const anomalies = detectLabelAnomalies(experiences, feedbackRecords);

  // Assertions
  assert.strictEqual(anomalies.missingLabels.length, 1);
  assert.strictEqual(anomalies.missingLabels[0].event_id, 'fb-3');

  assert.strictEqual(anomalies.contradictions.length, 2);
  const failureMarkedPos = anomalies.contradictions.find(c => c.type === 'failure_marked_positive');
  assert.ok(failureMarkedPos, 'Failed to detect failure_marked_positive contradiction');
  assert.strictEqual(failureMarkedPos.event_id, 'ev-1');

  const successMarkedNeg = anomalies.contradictions.find(c => c.type === 'success_marked_negative');
  assert.ok(successMarkedNeg, 'Failed to detect success_marked_negative contradiction');
  assert.strictEqual(successMarkedNeg.event_id, 'ev-2');
});

test('Pipeline Data Cleaning: strictly prevents failed actions from becoming SFT demonstrations', () => {
  const experiences = [
    // True success
    {
      event_id: 'ev-success',
      episode_id: 'ep-1',
      run_id: 'run-1',
      step: 1,
      goal: 'gather sand',
      decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
      execution: { status: 'success' },
      outcome: { reward: 1.0, task_progress: 1 },
      learning: { failure_detected: false, feedback_records: [] }
    },
    // Failed execution
    {
      event_id: 'ev-failed-exec',
      episode_id: 'ep-1',
      run_id: 'run-1',
      step: 2,
      goal: 'craft stick',
      decision: { action: 'craft_item', arguments: { item: 'stick' } },
      execution: { status: 'failed' },
      outcome: { reward: -0.5, task_progress: 0 },
      learning: { failure_detected: true, feedback_records: [] }
    },
    // Failure detected flag set
    {
      event_id: 'ev-fail-flag',
      episode_id: 'ep-1',
      run_id: 'run-1',
      step: 3,
      goal: 'navigate',
      decision: { action: 'navigate_to', arguments: { x: 10, y: 64, z: 10 } },
      execution: { status: 'success' },
      outcome: { reward: 0.5, task_progress: 0.5 },
      learning: { failure_detected: true, feedback_records: [] }
    },
    // Negative feedback from user
    {
      event_id: 'ev-neg-fb',
      episode_id: 'ep-1',
      run_id: 'run-1',
      step: 4,
      goal: 'chop wood',
      decision: { action: 'collect_resource', arguments: { resource: 'wood' } },
      execution: { status: 'success' },
      outcome: { reward: 1.0, task_progress: 1 },
      learning: { failure_detected: false, feedback_records: [{ label: 'negative' }] }
    }
  ];

  const datasets = generateSpecializedDatasets(experiences);

  // Only ev-success should qualify for SFT demonstrations
  assert.strictEqual(datasets.sftDemonstrations.length, 1);
  assert.strictEqual(datasets.sftDemonstrations[0].event_id, 'ev-success');

  // Failed actions are routed to failure recovery or DPO pairs, never SFT
  const sftEventIds = datasets.sftDemonstrations.map(d => d.event_id);
  assert.ok(!sftEventIds.includes('ev-failed-exec'), 'Failed action leaked into SFT demonstrations!');
  assert.ok(!sftEventIds.includes('ev-fail-flag'), 'Action with failure_detected leaked into SFT demonstrations!');
  assert.ok(!sftEventIds.includes('ev-neg-fb'), 'Action with negative feedback leaked into SFT demonstrations!');
});

test('Pipeline Data Cleaning: metadata correction fixes invalid outcome metrics on failed actions', () => {
  const rawRecord = {
    event_id: 'ev-invalid-meta',
    timestamp: new Date().toISOString(),
    observation_before: { agent: { position: { x: 0, y: 64, z: 0 } } },
    decision: { action: 'craft_item', arguments: { item: 'wooden_pickaxe' } },
    execution: { status: 'failed', error_code: 'MISSING_INGREDIENTS' },
    // Contradictory outcome: failed execution claiming positive progress and reward
    outcome: { task_progress: 1.0, reward: 2.5, predicted_outcome_met: true },
    learning: { failure_detected: false }
  };

  const validation = validateAndNormalizeRecord(rawRecord);
  assert.strictEqual(validation.valid, true);

  // Invariant corrections
  assert.strictEqual(validation.normalized.learning.failure_detected, true);
  assert.strictEqual(validation.normalized.outcome.task_progress, 0);
  assert.ok(validation.normalized.outcome.reward <= 0);
  assert.strictEqual(validation.normalized.outcome.predicted_outcome_met, false);
  assert.ok(validation.metadataCorrections.length >= 3);
});

test('Pipeline Learning: learns lessons and recovery rules into persistent memory from dataset', () => {
  const testDir = path.join('./data/test', 'pipeline_learning');
  fs.mkdirSync(testDir, { recursive: true });

  const memStore = new PersistentMemoryStore({
    filePath: path.join(testDir, 'memory.json'),
    lessonsFilePath: path.join(testDir, 'lessons.json'),
    strategiesFilePath: path.join(testDir, 'strategies.json'),
    locationsFilePath: path.join(testDir, 'locations.json'),
    deathsFilePath: path.join(testDir, 'deaths.json')
  });
  memStore.clear();

  const experiences = [
    {
      event_id: 'exp-rec-1',
      run_id: 'run-test',
      episode_id: 'ep-test',
      step: 1,
      goal: 'craft sticks',
      decision: { action: 'craft_item', arguments: { item: 'stick' } },
      execution: { status: 'failed', error_code: 'MISSING_INGREDIENTS' },
      outcome: { reward: -0.5, task_progress: 0 },
      learning: {
        failure_detected: true,
        failure_category: 'missing_prerequisite',
        feedback_records: [
          {
            event_type: 'correction',
            correction_proposed: 'craft_planks_first',
            retry_result: 'success',
            feedback_text: 'Craft planks before crafting sticks'
          }
        ],
        correction_applied: true,
        correction_verified: true
      }
    },
    {
      event_id: 'exp-rec-2',
      run_id: 'run-test',
      episode_id: 'ep-test',
      step: 2,
      goal: 'gather food',
      decision: { action: 'collect_resource', arguments: { resource: 'apple' } },
      execution: { status: 'success', duration_ms: 120 },
      outcome: { reward: 1.0, task_progress: 1 },
      learning: {
        failure_detected: false,
        feedback_records: [
          {
            event_type: 'user_feedback',
            label: 'positive',
            feedback_text: 'You must gather food'
          }
        ]
      }
    }
  ];

  const result = memStore.learnFromDataset({ experiences });
  assert.strictEqual(result.correctionsIngested, 1);
  assert.ok(result.lessonsLearned >= 1);
  assert.strictEqual(result.strategiesUpdated, 1);

  // Check persistent retrieval
  const memories = memStore.findRelevantMemories('craft_item:missing_prerequisite');
  assert.ok(memories.length > 0);
  assert.strictEqual(memories[0].validated_correction?.action, 'craft_planks_first');

  // Verify deterministic recovery rule engine
  const recMgr = new RecoveryManager({ memoryStore: memStore });
  const deterministicRule = recMgr.getDeterministicRecoveryRule(
    { failure_category: 'navigation', error_code: 'UNREACHABLE_TARGET' },
    { action: 'navigate_to' }
  );
  assert.ok(deterministicRule);
  assert.strictEqual(deterministicRule.action, 'look_around');
});

test('Pipeline Episode Splitting: guarantees zero trajectory leakage by episode and world', () => {
  const experiences = [
    { event_id: 'e1', environment: { world_id: 'w1' }, episode_id: 'ep-1', step: 1 },
    { event_id: 'e2', environment: { world_id: 'w1' }, episode_id: 'ep-1', step: 2 },
    { event_id: 'e3', environment: { world_id: 'w1' }, episode_id: 'ep-2', step: 1 },
    { event_id: 'e4', environment: { world_id: 'w2' }, episode_id: 'ep-3', step: 1 },
    { event_id: 'e5', environment: { world_id: 'w2' }, episode_id: 'ep-4', step: 1 }
  ];

  const split = splitByEpisode(experiences, 0.4);

  const trainKeys = new Set(split.trainEpisodes);
  const evalKeys = new Set(split.evalEpisodes);

  // No key can exist in both train and eval
  for (const k of trainKeys) {
    assert.strictEqual(evalKeys.has(k), false, `Leakage detected for ${k}`);
  }

  // All records of an episode stay strictly together
  const ep1Train = split.train.filter(r => r.episode_id === 'ep-1');
  const ep1Eval = split.eval.filter(r => r.episode_id === 'ep-1');
  assert.ok(ep1Train.length === 2 || ep1Eval.length === 2, 'ep-1 was split across sets');
  assert.ok(ep1Train.length === 0 || ep1Eval.length === 0, 'ep-1 leaked across sets');
});
