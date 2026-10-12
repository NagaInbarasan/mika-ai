import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  validateAndNormalizeRecord,
  parseJsonlFile,
  linkFeedbackRecords,
  generateSpecializedDatasets,
  splitByEpisode,
  runPreprocessing
} from '../src/data/preprocess.js';

test('validateAndNormalizeRecord verifies required fields and normalizes types', () => {
  // Invalid missing event_id
  const invalid = validateAndNormalizeRecord({
    timestamp: new Date().toISOString(),
    observation_before: {}
  });
  assert.strictEqual(invalid.valid, false);
  assert.ok(invalid.errors.some(e => e.includes('event_id')));

  // Valid record with numeric coercion
  const valid = validateAndNormalizeRecord({
    event_id: 'test-event-1',
    timestamp: '2026-10-11T12:00:00Z',
    observation_before: {
      agent: { position: { x: '12.5', y: '64', z: '-5' }, health: 18, food: 20 },
      inventory: [],
      nearby_threats: []
    },
    decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
    outcome: { task_progress: 1 }
  });

  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.normalized.observation_before.agent.position.x, 12.5);
  assert.strictEqual(valid.normalized.observation_before.agent.position.y, 64);
  assert.strictEqual(valid.normalized.observation_before.agent.position.z, -5);
  assert.strictEqual(valid.normalized.schema_version, '1.0');
});

test('parseJsonlFile skips malformed lines and deduplicates event_ids', () => {
  const testDir = path.join('./data/test', 'preprocess');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'raw_test.jsonl');

  const lines = [
    JSON.stringify({ event_id: 'ev-1', timestamp: '2026-10-11T12:00:00Z', observation_before: {} }),
    '{ malformed json line without closure',
    JSON.stringify({ event_id: 'ev-1', timestamp: '2026-10-11T12:00:01Z', observation_before: {} }), // duplicate
    JSON.stringify({ event_id: 'ev-2', timestamp: '2026-10-11T12:00:02Z', observation_before: {} })
  ];
  fs.writeFileSync(testFile, lines.join('\n'), 'utf-8');

  const parsed = parseJsonlFile(testFile);
  assert.strictEqual(parsed.totalLines, 4);
  assert.strictEqual(parsed.records.length, 2); // ev-1 and ev-2
  assert.strictEqual(parsed.duplicates, 1);
  assert.strictEqual(parsed.errors.length, 1);
  assert.strictEqual(parsed.errors[0].line, 2);

  // Cleanup
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
});

test('linkFeedbackRecords matches by related_event_id and fallback stepKey', () => {
  const experiences = [
    {
      event_id: 'ev-step-1',
      run_id: 'run-101',
      episode_id: 'ep-1',
      step: 1,
      learning: { feedback_event_ids: [], feedback_records: [] }
    },
    {
      event_id: 'ev-step-2',
      run_id: 'run-101',
      episode_id: 'ep-1',
      step: 2,
      learning: { feedback_event_ids: [], feedback_records: [] }
    }
  ];

  const feedbackRecords = [
    {
      event_id: 'fb-1',
      related_event_id: 'ev-step-1',
      event_type: 'user_feedback',
      label: 'positive',
      feedback_text: 'Good navigation'
    },
    {
      event_id: 'fb-2',
      related_event_id: null,
      run_id: 'run-101',
      episode_id: 'ep-1',
      step: 2,
      event_type: 'correction',
      label: 'negative',
      correction_proposed: 'craft_planks_first',
      retry_result: 'success'
    }
  ];

  const linkedCount = linkFeedbackRecords(experiences, feedbackRecords);
  assert.strictEqual(linkedCount, 2);

  // ev-step-1 linked
  assert.strictEqual(experiences[0].learning.feedback_event_ids[0], 'fb-1');
  assert.strictEqual(experiences[0].learning.feedback_records[0].label, 'positive');

  // ev-step-2 matched via fallback and marked correction_verified
  assert.strictEqual(experiences[1].learning.feedback_event_ids[0], 'fb-2');
  assert.strictEqual(experiences[1].learning.correction_applied, true);
  assert.strictEqual(experiences[1].learning.correction_verified, true);
});

test('generateSpecializedDatasets partitions into action, outcome, and recovery sets', () => {
  const experiences = [
    {
      event_id: 'ev-act',
      episode_id: 'ep-1',
      step: 1,
      goal: 'gather sand',
      observation_before: {
        agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
        inventory: [],
        nearby_threats: [],
        nearby_resources: [{ name: 'sand', distance: 2 }]
      },
      available_actions: ['collect_resource', 'stop'],
      decision: {
        action: 'collect_resource',
        arguments: { resource: 'sand' },
        reason_summary: 'Sand nearby',
        expected_outcome: 'inventory sand increases'
      },
      execution: { status: 'success' },
      outcome: {
        health_delta: 0,
        food_delta: 0,
        resource_delta: { sand: 1 },
        task_progress: 1,
        predicted_outcome_met: true
      },
      learning: {
        failure_detected: false,
        feedback_records: [{ label: 'positive' }]
      }
    },
    {
      event_id: 'ev-fail',
      episode_id: 'ep-2',
      step: 3,
      goal: 'craft sticks',
      observation_before: {
        agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
        inventory: []
      },
      decision: { action: 'craft_item', arguments: { item: 'stick' } },
      execution: { status: 'failed', error: 'Missing planks' },
      outcome: { task_progress: 0, predicted_outcome_met: false },
      learning: {
        failure_detected: true,
        failure_category: 'missing_prerequisite',
        feedback_records: [],
        correction_applied: true,
        correction_verified: true
      }
    }
  ];

  const datasets = generateSpecializedDatasets(experiences);

  // Action prediction
  assert.strictEqual(datasets.actionPrediction.length, 2);
  assert.strictEqual(datasets.actionPrediction[0].target.action, 'collect_resource');

  // Outcome prediction
  assert.strictEqual(datasets.outcomePrediction.length, 2);
  assert.strictEqual(datasets.outcomePrediction[0].target.resource_delta.sand, 1);

  // Failure recovery
  assert.strictEqual(datasets.failureRecovery.length, 1);
  assert.strictEqual(datasets.failureRecovery[0].failure_category, 'missing_prerequisite');
  assert.strictEqual(datasets.failureRecovery[0].failed_state.attempted_action, 'craft_item');

  // SFT Demonstrations (filters out failures)
  assert.strictEqual(datasets.sftDemonstrations.length, 1);
  assert.strictEqual(datasets.sftDemonstrations[0].messages.length, 3);
  assert.strictEqual(datasets.sftDemonstrations[0].messages[0].role, 'system');
});

test('splitByEpisode guarantees zero trajectory leakage between train and eval sets', () => {
  const experiences = [
    { event_id: 'e1', episode_id: 'ep-A', step: 1 },
    { event_id: 'e2', episode_id: 'ep-A', step: 2 },
    { event_id: 'e3', episode_id: 'ep-A', step: 3 },
    { event_id: 'e4', episode_id: 'ep-B', step: 1 },
    { event_id: 'e5', episode_id: 'ep-B', step: 2 },
    { event_id: 'e6', episode_id: 'ep-C', step: 1 },
    { event_id: 'e7', episode_id: 'ep-D', step: 1 },
    { event_id: 'e8', episode_id: 'ep-E', step: 1 }
  ];

  const split = splitByEpisode(experiences, 0.4);

  // Check distinct episodes
  const trainEpSet = new Set(split.trainEpisodes);
  const evalEpSet = new Set(split.evalEpisodes);

  // Zero intersection between train and eval episodes
  for (const ep of trainEpSet) {
    assert.strictEqual(evalEpSet.has(ep), false, `Episode ${ep} leaked into eval set!`);
  }

  // All steps from ep-A must be entirely in train or entirely in eval
  const epATrain = split.train.filter(r => r.episode_id === 'ep-A');
  const epAEval = split.eval.filter(r => r.episode_id === 'ep-A');
  assert.ok(epATrain.length === 3 || epAEval.length === 3, 'Steps of ep-A were split across train and eval!');
  assert.ok(epATrain.length === 0 || epAEval.length === 0, 'Steps of ep-A leaked across train and eval!');
});

test('runPreprocessing executes complete pipeline and outputs reports and datasets', () => {
  const testBase = path.join('./data/test', 'full_pipeline');
  const rawDir = path.join(testBase, 'raw');
  const processedDir = path.join(testBase, 'processed');
  const reportsDir = path.join(testBase, 'reports');

  fs.mkdirSync(rawDir, { recursive: true });

  const rawExpPath = path.join(rawDir, 'experiences.jsonl');
  const rawFbPath = path.join(rawDir, 'feedback.jsonl');

  const sampleExp = [
    JSON.stringify({
      schema_version: '1.0',
      event_id: 'ev-pipeline-1',
      run_id: 'run-1',
      episode_id: 'ep-1',
      step: 1,
      timestamp: '2026-10-11T12:00:00Z',
      observation_before: { agent: { position: { x: 0, y: 64, z: 0 } } },
      decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
      execution: { status: 'success', duration_ms: 50 },
      outcome: { task_progress: 1, resource_delta: { sand: 1 }, predicted_outcome_met: true }
    }),
    JSON.stringify({
      schema_version: '1.0',
      event_id: 'ev-pipeline-2',
      run_id: 'run-1',
      episode_id: 'ep-2',
      step: 1,
      timestamp: '2026-10-11T12:05:00Z',
      observation_before: { agent: { position: { x: 10, y: 64, z: 10 } } },
      decision: { action: 'navigate_to', arguments: { x: 0, z: 0 } },
      execution: { status: 'success', duration_ms: 120 },
      outcome: { task_progress: 1, predicted_outcome_met: true }
    })
  ];
  fs.writeFileSync(rawExpPath, sampleExp.join('\n'), 'utf-8');

  const sampleFb = [
    JSON.stringify({
      schema_version: '1.0',
      event_id: 'fb-pipeline-1',
      related_event_id: 'ev-pipeline-1',
      event_type: 'user_feedback',
      label: 'positive',
      feedback_text: 'Good job'
    })
  ];
  fs.writeFileSync(rawFbPath, sampleFb.join('\n'), 'utf-8');

  const report = runPreprocessing({
    rawExperiencesPath: rawExpPath,
    rawFeedbackPath: rawFbPath,
    processedDir,
    reportsDir,
    evalRatio: 0.5
  });

  assert.strictEqual(report.metrics.valid_clean_transitions, 2);
  assert.strictEqual(report.metrics.feedback_records_linked, 1);
  assert.strictEqual(report.specialized_datasets.action_prediction_samples, 2);
  assert.strictEqual(report.specialized_datasets.outcome_prediction_samples, 2);
  assert.strictEqual(report.specialized_datasets.sft_demonstration_samples, 2);

  // Files exist
  assert.ok(fs.existsSync(path.join(processedDir, 'clean_transitions.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'action_prediction.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'outcome_prediction.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'train.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'eval.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'train_actions.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'eval_actions.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'sft_chatml_train.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'sft_chatml_eval.jsonl')));
  assert.ok(fs.existsSync(path.join(processedDir, 'dpo_pairs.jsonl')));
  assert.ok(fs.existsSync(path.join(reportsDir, 'preprocessing_report.json')));

  // Cleanup
  fs.rmSync(testBase, { recursive: true, force: true });
});
