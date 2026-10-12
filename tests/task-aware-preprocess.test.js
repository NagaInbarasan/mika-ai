import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  archiveRawDatasets,
  validateOutcomeEvidence,
  extractConditionCluster,
  extractMethodSignature,
  calculateMethodProfiles,
  rankAndPrioritizeMethods,
  filterAndPrioritizeDataset,
  runTaskAwarePreprocessing
} from '../src/data/task-aware-preprocess.js';

test('Req 9: archiveRawDatasets archives raw data with SHA256 hashes before modifications', () => {
  const testDir = path.join('./data/test', 'archive_test');
  const rawDir = path.join(testDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const expContent = '{"event_id":"e-1","step":1}\n{"event_id":"e-2","step":2}\n';
  const fbContent = '{"event_id":"f-1","label":"positive"}\n';

  fs.writeFileSync(path.join(rawDir, 'experiences.jsonl'), expContent, 'utf-8');
  fs.writeFileSync(path.join(rawDir, 'feedback.jsonl'), fbContent, 'utf-8');

  const archiveResult = archiveRawDatasets(testDir, { timestamp: 'unit-test-archive' });

  assert.ok(fs.existsSync(archiveResult.archiveDir));
  assert.ok(fs.existsSync(archiveResult.manifestPath));

  const manifest = JSON.parse(fs.readFileSync(archiveResult.manifestPath, 'utf-8'));
  assert.strictEqual(manifest.total_files_archived, 2);

  const expFile = manifest.files.find(f => f.file_name === 'experiences.jsonl');
  assert.ok(expFile);
  assert.strictEqual(expFile.line_count, 2);
  assert.strictEqual(expFile.size_bytes, expContent.length);
  assert.strictEqual(typeof expFile.sha256, 'string');
  assert.strictEqual(expFile.sha256.length, 64); // SHA256 hex length
});

test('Req 2 & 7: validateOutcomeEvidence verifies game-state evidence and rejects unverified outcomes', () => {
  // 1. collect_resource: True positive inventory & resource delta
  const validCollect = {
    decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
    execution: { status: 'success' },
    observation_before: { inventory: [{ name: 'sand', count: 2 }] },
    observation_after: { inventory: [{ name: 'sand', count: 3 }] },
    outcome: { resource_delta: { sand: 1 }, task_progress: 1 }
  };
  const valResult1 = validateOutcomeEvidence(validCollect);
  assert.strictEqual(valResult1.verified, true);
  assert.strictEqual(valResult1.evidence.resource_gained, 1);

  // 2. collect_resource: Claimed success, but 0 resource gained and empty delta -> REJECTED
  const fakeCollect = {
    decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
    execution: { status: 'success' },
    observation_before: { inventory: [{ name: 'sand', count: 5 }] },
    observation_after: { inventory: [{ name: 'sand', count: 5 }] },
    outcome: { resource_delta: {}, task_progress: 0 }
  };
  const valResult2 = validateOutcomeEvidence(fakeCollect);
  assert.strictEqual(valResult2.verified, false);
  assert.ok(valResult2.rejectionReason.includes('collect_resource claimed success but no inventory or resource delta occurred'));

  // 3. navigate_to: Target reached or distance <= 2.5
  const validNav = {
    decision: { action: 'navigate_to', arguments: { x: 10, y: 64, z: 10 } },
    execution: { status: 'success' },
    outcome: { target_reached: true, distance_to_target: 1.2, task_progress: 1 }
  };
  assert.strictEqual(validateOutcomeEvidence(validNav).verified, true);

  // 4. navigate_to: Claimed success but agent didn't move -> REJECTED
  const stuckNav = {
    decision: { action: 'navigate_to', arguments: { x: 100, y: 64, z: 100 } },
    execution: { status: 'success' },
    outcome: { target_reached: false, distance_to_target: 95.0, position_delta: { distance_moved: 0 } }
  };
  assert.strictEqual(validateOutcomeEvidence(stuckNav).verified, false);

  // 5. craft_item: Item appears in resulting inventory
  const validCraft = {
    decision: { action: 'craft_item', arguments: { item: 'wooden_pickaxe' } },
    execution: { status: 'success' },
    observation_before: { inventory: [] },
    observation_after: { inventory: [{ name: 'wooden_pickaxe', count: 1 }] },
    outcome: { resource_delta: { wooden_pickaxe: 1 }, task_progress: 1 }
  };
  assert.strictEqual(validateOutcomeEvidence(validCraft).verified, true);

  // 6. Failed actions: Always unverified
  const failedAction = {
    decision: { action: 'craft_item', arguments: { item: 'iron_sword' } },
    execution: { status: 'failed', error: 'No iron ingots' }
  };
  assert.strictEqual(validateOutcomeEvidence(failedAction).verified, false);
});

test('Req 1 & 4: extractConditionCluster groups by environment and agent context without leakage', () => {
  const dayRecord = {
    goal: 'collect sand for shelter',
    decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
    environment: { dimension: 'overworld' },
    observation_before: {
      environment: { isDay: true, isRaining: false },
      agent: { health: 20 },
      nearby_threats: []
    }
  };

  const nightThreatRecord = {
    goal: 'collect sand during night raid',
    decision: { action: 'collect_resource', arguments: { resource: 'sand' } },
    environment: { dimension: 'overworld' },
    observation_before: {
      environment: { isDay: false, isRaining: false },
      agent: { health: 5 }, // critical
      nearby_threats: [{ name: 'spider', distance: 3.5 }]
    }
  };

  const cluster1 = extractConditionCluster(dayRecord);
  const cluster2 = extractConditionCluster(nightThreatRecord);

  // Assert condition cluster separation
  assert.strictEqual(cluster1.taskKey, 'COLLECT_RESOURCE:SAND');
  assert.strictEqual(cluster1.timePhase, 'day');
  assert.strictEqual(cluster1.healthBucket, 'healthy');
  assert.strictEqual(cluster1.threatStatus, 'threat_free');

  assert.strictEqual(cluster2.taskKey, 'COLLECT_RESOURCE:SAND');
  assert.strictEqual(cluster2.timePhase, 'night');
  assert.strictEqual(cluster2.healthBucket, 'critical');
  assert.strictEqual(cluster2.threatStatus, 'has_threats');

  assert.notStrictEqual(cluster1.clusterId, cluster2.clusterId, 'Day gathering and night threat gathering must not be grouped together');
});

test('Req 3, 5, 6: prioritizes reliable and safe methods over faster dangerous methods, preserving fallbacks', () => {
  // Scenario: Same condition cluster with 3 different methods:
  // - Method 1 (Fast Mine): Fast (500ms), but Unreliable (40% success rate, 3.5 HP damage taken)
  // - Method 2 (Safe Tool Mine): Moderate (1200ms), Highly Reliable (100% success rate, 0 HP damage)
  // - Method 3 (Careful Hand Mine): Slower (2500ms), Reliable (90% success rate, 0 HP damage)

  const clusterBase = {
    goal: 'collect sand',
    environment: { dimension: 'overworld' },
    observation_before: {
      environment: { isDay: true, isRaining: false },
      agent: { health: 20 },
      nearby_threats: []
    }
  };

  const experiences = [];

  // 10 attempts of Fast Mine: 4 successes, 6 failures, took 3.5 damage
  for (let i = 0; i < 10; i++) {
    const isSuccess = i < 4;
    experiences.push({
      ...clusterBase,
      event_id: `exp-fast-${i}`,
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'fast_pick' } },
      execution: { status: isSuccess ? 'success' : 'failed', duration_ms: 500 },
      outcome: {
        resource_delta: isSuccess ? { sand: 1 } : {},
        damage_taken: 3.5,
        task_progress: isSuccess ? 1 : 0
      }
    });
  }

  // 10 attempts of Safe Tool Mine: 10 successes, 0 failures, 0 damage
  for (let i = 0; i < 10; i++) {
    experiences.push({
      ...clusterBase,
      event_id: `exp-safe-${i}`,
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'stone_shovel' } },
      execution: { status: 'success', duration_ms: 1200 },
      outcome: {
        resource_delta: { sand: 1 },
        damage_taken: 0,
        task_progress: 1
      }
    });
  }

  // 10 attempts of Careful Hand Mine: 9 successes, 1 failure, 0 damage
  for (let i = 0; i < 10; i++) {
    const isSuccess = i < 9;
    experiences.push({
      ...clusterBase,
      event_id: `exp-careful-${i}`,
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'bare_hand' } },
      execution: { status: isSuccess ? 'success' : 'failed', duration_ms: 2500 },
      outcome: {
        resource_delta: isSuccess ? { sand: 1 } : {},
        damage_taken: 0,
        task_progress: isSuccess ? 1 : 0
      }
    });
  }

  const clusterMap = calculateMethodProfiles(experiences);
  assert.strictEqual(clusterMap.size, 1);

  const ranked = rankAndPrioritizeMethods(clusterMap, { minReliability: 0.80, maxDamageTolerance: 2.0 });
  const methods = ranked.values().next().value.rankedMethods;

  // Safe Tool Mine MUST be ranked #1 as PRIMARY
  const primaryMethod = methods.find(m => m.priority === 'primary');
  assert.ok(primaryMethod);
  assert.strictEqual(primaryMethod.methodInfo.tool, 'stone_shovel');
  assert.strictEqual(primaryMethod.success_rate, 1.0);
  assert.strictEqual(primaryMethod.training_weight, 1.0);

  // Careful Hand Mine MUST be preserved as FALLBACK (weight: 0.5)
  const fallbackMethod = methods.find(m => m.priority === 'fallback');
  assert.ok(fallbackMethod, 'Req 6: Useful alternative method was not preserved as fallback!');
  assert.strictEqual(fallbackMethod.methodInfo.tool, 'bare_hand');
  assert.strictEqual(fallbackMethod.training_weight, 0.5);

  // Fast Mine MUST be DEPRIORITIZED due to low reliability (40%) and high damage (3.5)
  const deprioritizedMethod = methods.find(m => m.priority === 'deprioritized');
  assert.ok(deprioritizedMethod, 'Unsafe/unreliable method was not deprioritized!');
  assert.strictEqual(deprioritizedMethod.methodInfo.tool, 'fast_pick');
  assert.strictEqual(deprioritizedMethod.training_weight, 0.0);
});

test('Req 7 & 8: filterAndPrioritizeDataset cleans duplicates/unverified and preserves failure recovery', () => {
  const baseRecord = {
    goal: 'collect sand',
    environment: { dimension: 'overworld' },
    observation_before: {
      environment: { isDay: true, isRaining: false },
      agent: { health: 20 },
      nearby_threats: []
    }
  };

  const experiences = [
    // 1. Verified primary method record
    {
      ...baseRecord,
      event_id: 'ev-1',
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'stone_shovel' } },
      execution: { status: 'success', duration_ms: 1100 },
      outcome: { resource_delta: { sand: 1 }, task_progress: 1 }
    },
    // 2. Exact duplicate of ev-1
    {
      ...baseRecord,
      event_id: 'ev-1-dup',
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'stone_shovel' } },
      execution: { status: 'success', duration_ms: 1100 },
      outcome: { resource_delta: { sand: 1 }, task_progress: 1 }
    },
    // 3. Unverified outcome: claimed success but resource_delta is empty
    {
      ...baseRecord,
      event_id: 'ev-unverified',
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'stone_shovel' } },
      execution: { status: 'success', duration_ms: 1100 },
      outcome: { resource_delta: {}, task_progress: 0 }
    },
    // 4. Failed attempt with recovery lesson
    {
      ...baseRecord,
      event_id: 'ev-failed-recovery',
      decision: { action: 'collect_resource', arguments: { resource: 'sand', tool: 'stone_shovel' } },
      execution: { status: 'failed', error: 'TOOL_BROKEN' },
      outcome: { resource_delta: {}, task_progress: 0, reward: -0.5 },
      learning: {
        failure_detected: true,
        failure_category: 'tool_durability',
        feedback_records: [
          { event_type: 'correction', correction_proposed: 'craft_new_shovel', retry_result: 'success' }
        ],
        correction_applied: true,
        correction_verified: true
      }
    }
  ];

  const clusterMap = calculateMethodProfiles(experiences);
  const ranked = rankAndPrioritizeMethods(clusterMap);
  const filtered = filterAndPrioritizeDataset(experiences, ranked);

  // Exact duplicate was removed
  assert.strictEqual(filtered.removedRecords.exact_duplicates, 1);

  // Unverified outcome was removed from SFT
  assert.strictEqual(filtered.removedRecords.unverified_outcomes, 1);

  // Verified primary demonstration was retained
  assert.strictEqual(filtered.sftDemonstrations.length, 1);
  assert.strictEqual(filtered.sftDemonstrations[0].event_id, 'ev-1');
  assert.strictEqual(filtered.sftDemonstrations[0].metadata.priority, 'primary');

  // Failed attempt preserved for failure recovery
  assert.strictEqual(filtered.failureRecovery.length, 1);
  assert.strictEqual(filtered.failureRecovery[0].event_id, 'ev-failed-recovery');
  assert.strictEqual(filtered.failureRecovery[0].failure_category, 'tool_durability');

  // DPO contrastive pair extracted
  assert.strictEqual(filtered.dpoPairs.length, 1);
  assert.strictEqual(filtered.dpoPairs[0].chosen.action, 'craft_new_shovel');
  assert.strictEqual(filtered.dpoPairs[0].rejected.action, 'collect_resource');
});

test('Req 10 & 11: runTaskAwarePreprocessing produces complete report and leakage-free dataset splits', () => {
  const testDir = path.join('./data/test', 'full_pipeline_test');
  const rawDir = path.join(testDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const rawExps = [];
  // Episode 1 (Train)
  for (let i = 1; i <= 6; i++) {
    rawExps.push({
      schema_version: '1.0',
      event_id: `test-ep1-step-${i}`,
      run_id: 'run-test',
      episode_id: 'ep-01',
      step: i,
      timestamp: new Date().toISOString(),
      goal: 'collect wood',
      environment: { dimension: 'overworld' },
      observation_before: {
        agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
        environment: { isDay: true, isRaining: false },
        inventory: []
      },
      decision: { action: 'collect_resource', arguments: { resource: 'wood' } },
      execution: { status: 'success', duration_ms: 1500 },
      outcome: { resource_delta: { wood: 1 }, task_progress: 1, reward: 1 },
      learning: { failure_detected: false }
    });
  }

  // Episode 2 (Eval)
  for (let i = 1; i <= 4; i++) {
    rawExps.push({
      schema_version: '1.0',
      event_id: `test-ep2-step-${i}`,
      run_id: 'run-test',
      episode_id: 'ep-02',
      step: i,
      timestamp: new Date().toISOString(),
      goal: 'collect wood',
      environment: { dimension: 'overworld' },
      observation_before: {
        agent: { position: { x: 10, y: 64, z: 10 }, health: 20, food: 20 },
        environment: { isDay: true, isRaining: false },
        inventory: []
      },
      decision: { action: 'collect_resource', arguments: { resource: 'wood' } },
      execution: { status: 'success', duration_ms: 1400 },
      outcome: { resource_delta: { wood: 1 }, task_progress: 1, reward: 1 },
      learning: { failure_detected: false }
    });
  }

  fs.writeFileSync(path.join(rawDir, 'experiences.jsonl'), rawExps.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(rawDir, 'feedback.jsonl'), '', 'utf-8');

  const report = runTaskAwarePreprocessing({
    dataDir: testDir,
    evalRatio: 0.5
  });

  // Check report structure (Req 11)
  assert.ok(report.archive_manifest);
  assert.strictEqual(report.source_metrics.valid_clean_transitions, 10);
  assert.strictEqual(report.filtering_and_prioritization.retained_sft_demonstrations, 10);
  assert.strictEqual(report.condition_clusters_summary.total_clusters, 1);

  // Check method metrics in report (Req 3 & 11)
  const cluster = report.condition_clusters_summary.clusters[0];
  assert.strictEqual(cluster.methods_evaluated.length, 1);
  const method = cluster.methods_evaluated[0];
  assert.strictEqual(method.attempts, 10);
  assert.strictEqual(method.verified_successes, 10);
  assert.strictEqual(method.success_rate, 1.0);
  assert.strictEqual(method.priority, 'primary');

  // Check leakage-free episode split (Req 10)
  assert.strictEqual(report.splits.train_episodes.length, 1);
  assert.strictEqual(report.splits.eval_episodes.length, 1);
  assert.notStrictEqual(report.splits.train_episodes[0], report.splits.eval_episodes[0]);

  // Check files on disk
  const sftTrain = path.join(testDir, 'processed', 'sft_chatml_train.jsonl');
  const sftEval = path.join(testDir, 'processed', 'sft_chatml_eval.jsonl');
  assert.ok(fs.existsSync(sftTrain));
  assert.ok(fs.existsSync(sftEval));
  assert.strictEqual(fs.readFileSync(sftTrain, 'utf-8').trim().split('\n').length, report.splits.train_sft_samples);
  assert.strictEqual(fs.readFileSync(sftEval, 'utf-8').trim().split('\n').length, report.splits.eval_sft_samples);
});
