import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import config from '../config/index.js';
import {
  validateAndNormalizeRecord,
  parseJsonlFile,
  linkFeedbackRecords,
  detectLabelAnomalies,
  extractDpoPairs,
  splitByEpisode,
  getEpisodeKey
} from './preprocess.js';

/**
 * Archives raw datasets before any modifications are made.
 * Complies with Requirement 9: "Archive the original dataset before any modifications."
 *
 * @param {string} dataDir - Root data directory
 * @param {Object} [options={}] - Options (archiveDir, timestamp)
 * @returns {Object} Archive manifest report
 */
export function archiveRawDatasets(dataDir, options = {}) {
  const rawDir = path.join(dataDir, 'raw');
  const timestamp = options.timestamp || new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = options.archiveDir || path.join(dataDir, 'archive', `raw_backup_${timestamp}`);

  fs.mkdirSync(archiveDir, { recursive: true });

  const archivedFiles = [];
  const rawFiles = ['experiences.jsonl', 'feedback.jsonl'];

  for (const fileName of rawFiles) {
    const srcPath = path.join(rawDir, fileName);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(archiveDir, fileName);
      const content = fs.readFileSync(srcPath);
      fs.writeFileSync(destPath, content);

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const lines = content.toString('utf-8').split(/\r?\n/).filter(l => l.trim().length > 0).length;

      archivedFiles.push({
        file_name: fileName,
        source_path: srcPath,
        archive_path: destPath,
        size_bytes: content.length,
        line_count: lines,
        sha256: hash
      });
    }
  }

  const manifest = {
    archived_at: new Date().toISOString(),
    archive_dir: archiveDir,
    total_files_archived: archivedFiles.length,
    files: archivedFiles
  };

  const manifestPath = path.join(archiveDir, 'archive_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return {
    archiveDir,
    manifestPath,
    archivedFiles,
    timestamp
  };
}

/**
 * Validates task outcomes using actual Minecraft game-state evidence.
 * Complies with Requirement 2 & 7: "Validate task outcomes using actual game-state evidence where available."
 *
 * Checks physical inventory changes, position deltas, health/food changes, and execution status.
 *
 * @param {Object} exp - Normalized experience record
 * @returns {{ verified: boolean, confidence: number, evidence: Object, rejectionReason: string|null }}
 */
export function validateOutcomeEvidence(exp) {
  if (!exp || typeof exp !== 'object') {
    return { verified: false, confidence: 0, evidence: {}, rejectionReason: 'Invalid record object' };
  }

  const executionStatus = exp.execution?.status || 'unknown';
  const isFailed = executionStatus === 'failed' || executionStatus === 'timeout' || Boolean(exp.learning?.failure_detected);

  // If action explicitly failed, outcome cannot be a verified success
  if (isFailed) {
    return {
      verified: false,
      confidence: 1.0,
      evidence: { execution_status: executionStatus, error: exp.execution?.error || exp.execution?.error_code },
      rejectionReason: `Execution failed with status '${executionStatus}'`
    };
  }

  const outcome = exp.outcome || {};

  // Actions resulting in net negative reward or unmitigated damage cannot be verified positive demonstrations
  if (typeof outcome.reward === 'number' && outcome.reward < 0) {
    return {
      verified: false,
      confidence: 1.0,
      evidence: { reward: outcome.reward, damage_taken: outcome.damage_taken },
      rejectionReason: `Action resulted in negative reward (${outcome.reward})`
    };
  }

  const action = exp.decision?.action || 'unknown';
  const args = exp.decision?.arguments || {};
  const obsBefore = exp.observation_before || {};
  const obsAfter = exp.observation_after || null;

  // 1. collect_resource: Must show physical inventory increase or non-empty positive resource_delta
  if (action === 'collect_resource') {
    const targetResource = String(args.resource || '').toLowerCase().trim();
    const resDelta = outcome.resource_delta || {};
    let resourceGained = 0;

    // Check outcome resource_delta
    if (targetResource && typeof resDelta[targetResource] === 'number') {
      resourceGained = resDelta[targetResource];
    } else {
      // Sum all positive deltas
      for (const count of Object.values(resDelta)) {
        if (typeof count === 'number' && count > 0) {
          resourceGained += count;
        }
      }
    }

    // Check observation inventory diff if available
    let invGained = 0;
    if (obsAfter && Array.isArray(obsAfter.inventory) && Array.isArray(obsBefore.inventory)) {
      const countItem = (inv, target) => {
        return inv
          .filter(item => !target || item.name?.toLowerCase().includes(target) || target.includes(item.name?.toLowerCase()))
          .reduce((sum, item) => sum + (item.count || 0), 0);
      };
      const beforeCount = countItem(obsBefore.inventory, targetResource);
      const afterCount = countItem(obsAfter.inventory, targetResource);
      invGained = Math.max(0, afterCount - beforeCount);
    }

    const verifiedAmount = Math.max(resourceGained, invGained);
    if (verifiedAmount > 0) {
      return {
        verified: true,
        confidence: 1.0,
        evidence: {
          action: 'collect_resource',
          target_resource: targetResource,
          resource_gained: verifiedAmount,
          resource_delta: resDelta
        },
        rejectionReason: null
      };
    }

    // If claimed success, but 0 resource was gained, outcome is unverified!
    return {
      verified: false,
      confidence: 0.9,
      evidence: { action: 'collect_resource', target_resource: targetResource, resource_delta: resDelta },
      rejectionReason: `collect_resource claimed success but no inventory or resource delta occurred (amount: 0)`
    };
  }

  // 2. craft_item: Target item must be in resulting inventory or positive delta
  if (action === 'craft_item') {
    const targetItem = String(args.item || args.recipe || '').toLowerCase().trim();
    const resDelta = outcome.resource_delta || {};
    let craftVerified = false;

    if (targetItem && typeof resDelta[targetItem] === 'number' && resDelta[targetItem] > 0) {
      craftVerified = true;
    }

    if (!craftVerified && obsAfter && Array.isArray(obsAfter.inventory) && Array.isArray(obsBefore.inventory)) {
      const findItemCount = (inv, name) => inv.filter(i => i.name?.toLowerCase().includes(name)).reduce((s, i) => s + (i.count || 0), 0);
      const beforeCount = findItemCount(obsBefore.inventory, targetItem);
      const afterCount = findItemCount(obsAfter.inventory, targetItem);
      if (afterCount > beforeCount) {
        craftVerified = true;
      }
    }

    if (craftVerified) {
      return {
        verified: true,
        confidence: 1.0,
        evidence: { action: 'craft_item', target_item: targetItem },
        rejectionReason: null
      };
    }

    return {
      verified: false,
      confidence: 0.9,
      evidence: { action: 'craft_item', target_item: targetItem },
      rejectionReason: `craft_item claimed success but crafted item '${targetItem}' was not added to inventory`
    };
  }

  // 3. navigate_to: Verified by destination arrival or distance moved towards target
  if (action === 'navigate_to') {
    const targetReached = outcome.target_reached === true;
    const distanceToTarget = typeof outcome.distance_to_target === 'number' ? outcome.distance_to_target : null;
    const posDelta = outcome.position_delta || {};
    const distanceMoved = typeof posDelta.distance_moved === 'number' ? posDelta.distance_moved : 0;

    if (targetReached || (distanceToTarget !== null && distanceToTarget <= 2.5) || (distanceMoved > 0.5 && (outcome.task_progress || 0) > 0)) {
      return {
        verified: true,
        confidence: targetReached ? 1.0 : 0.85,
        evidence: {
          action: 'navigate_to',
          target_reached: targetReached,
          distance_to_target: distanceToTarget,
          distance_moved: distanceMoved
        },
        rejectionReason: null
      };
    }

    return {
      verified: false,
      confidence: 0.8,
      evidence: { action: 'navigate_to', target_reached: targetReached, distance_to_target: distanceToTarget, distance_moved: distanceMoved },
      rejectionReason: `navigate_to claimed success but agent did not move or arrive within target range`
    };
  }

  // 4. eat_food: Must show food level delta or saturation increase
  if (action === 'eat_food') {
    const foodDelta = outcome.food_delta || 0;
    const beforeFood = obsBefore.agent?.food ?? 0;
    const afterFood = obsAfter?.agent?.food ?? beforeFood;
    const foodRestored = Math.max(foodDelta, afterFood - beforeFood);

    if (foodRestored > 0 || (outcome.task_progress > 0 && executionStatus === 'success')) {
      return {
        verified: true,
        confidence: 1.0,
        evidence: { action: 'eat_food', food_restored: foodRestored },
        rejectionReason: null
      };
    }

    return {
      verified: false,
      confidence: 0.85,
      evidence: { action: 'eat_food', food_delta: foodDelta },
      rejectionReason: `eat_food claimed success but food level did not increase`
    };
  }

  // 5. attack_target / defend: Threats reduced or neutralized
  if (action === 'attack_target' || action === 'defend') {
    const damageDealt = outcome.damage_dealt || 0;
    const threatNeutralized = outcome.threat_neutralized || outcome.task_progress > 0;
    if (threatNeutralized || damageDealt > 0 || executionStatus === 'success') {
      return {
        verified: true,
        confidence: 0.9,
        evidence: { action, damage_dealt: damageDealt, threat_neutralized: threatNeutralized },
        rejectionReason: null
      };
    }
  }

  // 6. Observational / Informational actions (look_around, inspect_inventory, stop)
  if (['look_around', 'inspect_inventory', 'stop'].includes(action)) {
    if (executionStatus === 'success' || executionStatus === 'observed') {
      return {
        verified: true,
        confidence: 0.95,
        evidence: { action, execution_status: executionStatus },
        rejectionReason: null
      };
    }
  }

  // Fallback for general actions: Require success status and positive task progress or reward
  if (executionStatus === 'success' && (outcome.task_progress > 0 || (typeof outcome.reward === 'number' && outcome.reward > 0))) {
    return {
      verified: true,
      confidence: 0.8,
      evidence: { action, execution_status: executionStatus, task_progress: outcome.task_progress, reward: outcome.reward },
      rejectionReason: null
    };
  }

  return {
    verified: false,
    confidence: 0.75,
    evidence: { action, execution_status: executionStatus, outcome },
    rejectionReason: `Unverified outcome for action '${action}': no verifiable state delta or progress`
  };
}

/**
 * Extracts condition clustering features to ensure fair, apples-to-apples comparisons.
 * Complies with Requirements 1 & 4: "Group experience records by task, goal, starting conditions, and environment"
 * and "Compare methods only across sufficiently similar conditions."
 *
 * @param {Object} exp - Experience record
 * @returns {Object} Condition cluster details
 */
export function extractConditionCluster(exp) {
  const goalStr = String(exp.goal || '').toLowerCase().trim();
  const actionStr = String(exp.decision?.action || 'unknown').toLowerCase().trim();
  const targetResource = String(exp.decision?.arguments?.resource || exp.decision?.arguments?.item || '').toLowerCase().trim();

  // Normalize task key
  let taskKey = actionStr.toUpperCase();
  if (targetResource) {
    taskKey = `${taskKey}:${targetResource.toUpperCase()}`;
  } else if (goalStr.includes('sand')) {
    taskKey = 'COLLECT_RESOURCE:SAND';
  } else if (goalStr.includes('wood') || goalStr.includes('log')) {
    taskKey = 'COLLECT_RESOURCE:WOOD';
  } else if (goalStr.includes('threat') || goalStr.includes('spider') || goalStr.includes('zombie')) {
    taskKey = 'SURVIVE_THREAT';
  } else if (goalStr.includes('navigate') || goalStr.includes('move')) {
    taskKey = 'NAVIGATE_TO';
  }

  // Environment conditions
  const env = exp.environment || {};
  const dimension = String(env.dimension || 'overworld').toLowerCase();

  const obs = exp.observation_before || {};
  const obsEnv = obs.environment || {};
  const timePhase = obsEnv.isDay === false ? 'night' : 'day';
  const weather = obsEnv.isRaining ? 'rain' : 'clear';

  // Agent starting condition buckets
  const health = typeof obs.agent?.health === 'number' ? obs.agent.health : 20;
  let healthBucket = 'healthy';
  if (health <= 6) {
    healthBucket = 'critical';
  } else if (health <= 13) {
    healthBucket = 'low';
  }

  const threats = Array.isArray(obs.nearby_threats) ? obs.nearby_threats : [];
  const threatStatus = threats.length > 0 ? 'has_threats' : 'threat_free';

  const clusterId = `${taskKey}__${dimension}__${timePhase}__${weather}__${healthBucket}__${threatStatus}`;

  return {
    clusterId,
    taskKey,
    dimension,
    timePhase,
    weather,
    healthBucket,
    threatStatus
  };
}

/**
 * Extracts method signature from an experience record.
 * Identifies the specific technique, tool, and execution pattern.
 *
 * @param {Object} exp - Experience record
 * @returns {Object} Method signature
 */
export function extractMethodSignature(exp) {
  const action = exp.decision?.action || 'stop';
  const args = exp.decision?.arguments || {};
  const mainHand = exp.observation_before?.equipment?.mainhand?.name || args.tool || 'bare_hand';
  const variant = args.method || args.variant || (args.sprint ? 'sprint' : 'standard');

  const methodId = `${action}__with_${mainHand}__${variant}`;

  return {
    methodId,
    action,
    tool: mainHand,
    variant
  };
}

/**
 * Calculates metrics and profiles for each method across all condition clusters.
 * Complies with Requirement 3: "Calculate success rate, completion time, action count,
 * resource cost, damage, and failure rate for each method."
 *
 * @param {Object[]} cleanExperiences - Normalized experience records
 * @returns {Map<string, Map<string, Object>>} Map of Cluster ID -> Map of Method ID -> Profile
 */
export function calculateMethodProfiles(cleanExperiences) {
  const clusterMap = new Map();

  for (const exp of cleanExperiences) {
    if (!exp.decision || !exp.decision.action) continue;

    const cluster = extractConditionCluster(exp);
    const method = extractMethodSignature(exp);
    const outcomeValidation = validateOutcomeEvidence(exp);

    if (!clusterMap.has(cluster.clusterId)) {
      clusterMap.set(cluster.clusterId, {
        clusterInfo: cluster,
        methods: new Map()
      });
    }

    const clusterEntry = clusterMap.get(cluster.clusterId);
    if (!clusterEntry.methods.has(method.methodId)) {
      clusterEntry.methods.set(method.methodId, {
        methodInfo: method,
        attempts: 0,
        verified_successes: 0,
        failures: 0,
        unverified_outcomes: 0,
        total_duration_ms: 0,
        total_actions: 0,
        total_damage_taken: 0,
        total_resource_cost: 0,
        sample_records: []
      });
    }

    const m = clusterEntry.methods.get(method.methodId);
    m.attempts += 1;
    m.sample_records.push(exp);

    const isExecutionFailed = exp.execution?.status === 'failed' || exp.execution?.status === 'timeout' || Boolean(exp.learning?.failure_detected);
    const damage = Math.max(0, exp.outcome?.damage_taken || (exp.outcome?.health_delta ? -exp.outcome.health_delta : 0));
    const duration = typeof exp.execution?.duration_ms === 'number' ? exp.execution.duration_ms : 0;
    const actions = typeof exp.execution?.step_count === 'number' ? exp.execution.step_count : 1;
    const cost = typeof exp.outcome?.resource_cost === 'number' ? exp.outcome.resource_cost : 0;

    m.total_duration_ms += duration;
    m.total_actions += actions;
    m.total_damage_taken += damage;
    m.total_resource_cost += cost;

    if (isExecutionFailed) {
      m.failures += 1;
    } else if (outcomeValidation.verified) {
      m.verified_successes += 1;
    } else {
      m.unverified_outcomes += 1;
      m.failures += 1; // Unverified outcome is treated as failure
    }
  }

  // Finalize statistics
  for (const [, clusterEntry] of clusterMap.entries()) {
    for (const [, m] of clusterEntry.methods.entries()) {
      const attempts = Math.max(1, m.attempts);
      m.success_rate = Number((m.verified_successes / attempts).toFixed(4));
      m.failure_rate = Number((m.failures / attempts).toFixed(4));
      m.avg_duration_ms = Math.round(m.total_duration_ms / attempts);
      m.avg_actions = Number((m.total_actions / attempts).toFixed(2));
      m.avg_damage_taken = Number((m.total_damage_taken / attempts).toFixed(2));
      m.avg_resource_cost = Number((m.total_resource_cost / attempts).toFixed(2));

      // Safety score: 1.0 down to 0.0 penalized by damage taken
      m.safety_score = Number(Math.max(0, 1.0 - (m.avg_damage_taken / 10.0)).toFixed(4));

      // Efficiency score: speed + action economy
      // Higher is faster with fewer actions
      const timeFactor = 1000.0 / Math.max(50, m.avg_duration_ms);
      const actionFactor = 1.0 / Math.max(1, m.avg_actions);
      m.efficiency_score = Number((timeFactor * actionFactor).toFixed(4));
    }
  }

  return clusterMap;
}

/**
 * Ranks and prioritizes methods within each condition cluster.
 * Complies with Requirements 4, 5, 6:
 * - "Compare methods only across sufficiently similar conditions."
 * - "Prefer faster methods with fewer actions ONLY when reliability and safety are maintained."
 * - "Preserve useful old successful methods as fallback examples. Mark inferior methods as lower priority."
 *
 * @param {Map<string, Object>} clusterMap - Cluster map with method profiles
 * @param {Object} [options={}] - Configurable criteria
 * @returns {Map<string, Object>} Ranked clusters with assigned priorities
 */
export function rankAndPrioritizeMethods(clusterMap, options = {}) {
  const minReliability = options.minReliability ?? 0.80;
  const maxDamageTolerance = options.maxDamageTolerance ?? 2.0;

  const rankedClusters = new Map();

  for (const [clusterId, clusterData] of clusterMap.entries()) {
    const methodsList = Array.from(clusterData.methods.values());

    // Evaluate each method
    for (const m of methodsList) {
      const meetsReliability = m.success_rate >= minReliability;
      const meetsSafety = m.avg_damage_taken <= maxDamageTolerance;
      m.is_safe_and_reliable = meetsReliability && meetsSafety;

      // Ranking score: Prioritizes reliability and safety over raw speed
      // Speed only gives an edge when reliable and safe!
      m.composite_score = Number(
        (m.success_rate * 0.5 + m.safety_score * 0.3 + Math.min(1.0, m.efficiency_score / 10.0) * 0.2).toFixed(4)
      );
    }

    // Sort methods:
    // 1. Safe & reliable methods always beat unsafe/unreliable ones
    // 2. Highest composite score (combining safety, reliability, and speed) wins
    methodsList.sort((a, b) => {
      if (a.is_safe_and_reliable !== b.is_safe_and_reliable) {
        return a.is_safe_and_reliable ? -1 : 1;
      }
      if (b.success_rate !== a.success_rate) {
        return b.success_rate - a.success_rate;
      }
      return b.composite_score - a.composite_score;
    });

    // Assign priorities:
    // - Top method -> 'primary' (weight: 1.0)
    // - Other verified successful methods -> 'fallback' (weight: 0.5) - PRESERVED per Req 6!
    // - Unsafe/unreliable methods -> 'deprioritized' (weight: 0.0)
    let primaryAssigned = false;
    for (let i = 0; i < methodsList.length; i++) {
      const m = methodsList[i];
      if (!primaryAssigned && m.verified_successes > 0 && (m.is_safe_and_reliable || methodsList.length === 1)) {
        m.priority = 'primary';
        m.training_weight = 1.0;
        m.priority_rationale = `Highest performing verified method in cluster (Success: ${(m.success_rate * 100).toFixed(1)}%, Avg Time: ${m.avg_duration_ms}ms, Damage: ${m.avg_damage_taken})`;
        primaryAssigned = true;
      } else if (m.is_safe_and_reliable && m.verified_successes > 0) {
        // PRESERVED FALLBACK EXAMPLE (Requirement 6)
        m.priority = 'fallback';
        m.training_weight = 0.5;
        m.priority_rationale = `Preserved as valid alternative/fallback strategy (Success: ${(m.success_rate * 100).toFixed(1)}%, Avg Time: ${m.avg_duration_ms}ms)`;
      } else {
        m.priority = 'deprioritized';
        m.training_weight = 0.0;
        m.priority_rationale = `Deprioritized due to insufficient verified reliability (${(m.success_rate * 100).toFixed(1)}%) or high damage risk (${m.avg_damage_taken})`;
      }
    }

    rankedClusters.set(clusterId, {
      clusterInfo: clusterData.clusterInfo,
      rankedMethods: methodsList
    });
  }

  return rankedClusters;
}

/**
 * Filters, sanitizes, and prioritizes records for supervised training and evaluation.
 * Complies with Requirements 6, 7, 8:
 * - Removes corrupted records, exact duplicates, invalid labels, unverified outcomes.
 * - Preserves primary and fallback methods with appropriate weights.
 * - Preserves failure attempts that provide useful recovery lessons with accurate failure labels.
 *
 * @param {Object[]} cleanExperiences - Normalized experiences
 * @param {Map<string, Object>} rankedClusters - Ranked condition clusters
 * @param {Object} [options={}] - Filter options
 * @returns {Object} Filtered datasets and metrics report
 */
export function filterAndPrioritizeDataset(cleanExperiences, rankedClusters, options = {}) {
  const sftDemonstrations = [];
  const actionPredictions = [];
  const failureRecovery = [];
  const removedRecords = {
    exact_duplicates: 0,
    unverified_outcomes: 0,
    corrupted_or_invalid: 0,
    deprioritized_inferior: 0,
    details: []
  };
  const prioritizedCounts = {
    primary: 0,
    fallback: 0,
    deprioritized: 0
  };

  const seenSignatures = new Set();
  const seenEventIds = new Set();

  for (const exp of cleanExperiences) {
    if (!exp.decision || !exp.decision.action) continue;

    // Deduplication check: duplicate event_id, episode step, or exact identical state+decision+outcome
    let isDuplicate = false;
    let dedupeKey = '';

    if (exp.event_id && seenEventIds.has(exp.event_id)) {
      isDuplicate = true;
    } else {
      if (exp.event_id) seenEventIds.add(exp.event_id);

      if (exp.episode_id && exp.step !== undefined && exp.step !== null) {
        dedupeKey = `${exp.run_id || ''}:${exp.episode_id}:${exp.step}`;
      } else {
        dedupeKey = `${exp.decision.action}:${JSON.stringify(exp.decision.arguments || {})}:${JSON.stringify(exp.observation_before?.agent?.position || {})}:${JSON.stringify(exp.outcome || {})}`;
      }

      if (seenSignatures.has(dedupeKey)) {
        isDuplicate = true;
      } else {
        seenSignatures.add(dedupeKey);
      }
    }

    if (isDuplicate) {
      removedRecords.exact_duplicates += 1;
      removedRecords.details.push({
        event_id: exp.event_id,
        reason: 'Exact duplicate record'
      });
      continue;
    }

    // Physical game-state outcome validation
    const outcomeVal = validateOutcomeEvidence(exp);
    const cluster = extractConditionCluster(exp);
    const method = extractMethodSignature(exp);

    const clusterEntry = rankedClusters.get(cluster.clusterId);
    const methodProfile = clusterEntry?.rankedMethods.find(m => m.methodInfo.methodId === method.methodId);
    const priority = methodProfile?.priority || 'deprioritized';
    const trainingWeight = methodProfile?.training_weight || 0.0;

    // Failure recovery preservation (Requirement 8)
    const isExecutionFailed = exp.execution?.status === 'failed' || exp.execution?.status === 'timeout' || Boolean(exp.learning?.failure_detected);
    if (isExecutionFailed || exp.learning?.correction_applied) {
      failureRecovery.push({
        event_id: exp.event_id,
        episode_id: exp.episode_id,
        run_id: exp.run_id,
        failed_state: {
          goal: exp.goal,
          observation: exp.observation_before,
          attempted_action: exp.decision.action,
          arguments: exp.decision.arguments,
          error_message: exp.execution?.error || exp.execution?.error_code || 'Unverified or failed execution'
        },
        failure_category: exp.learning?.failure_category || 'execution_failure',
        linked_feedback: exp.learning?.feedback_records || [],
        correction: {
          correction_applied: exp.learning?.correction_applied,
          correction_verified: exp.learning?.correction_verified
        }
      });
    }

    // Outcome unverified check (Requirement 7)
    if (!outcomeVal.verified && !isExecutionFailed) {
      removedRecords.unverified_outcomes += 1;
      removedRecords.details.push({
        event_id: exp.event_id,
        action: exp.decision.action,
        reason: outcomeVal.rejectionReason || 'Game-state evidence failed verification'
      });
      continue;
    }

    // Deprioritized method check (Requirement 6 & 7)
    if (priority === 'deprioritized') {
      prioritizedCounts.deprioritized += 1;
      removedRecords.deprioritized_inferior += 1;
      continue;
    }

    // Only verified successes with non-negative rewards and zero failure flags are included in SFT demonstrations
    const hasNegativeFeedback = exp.learning?.feedback_records?.some(f => f.label === 'negative');
    const isNegativeReward = typeof exp.outcome?.reward === 'number' && exp.outcome.reward < 0;

    const isStrictSuccess = outcomeVal.verified &&
                            !isExecutionFailed &&
                            !hasNegativeFeedback &&
                            !isNegativeReward &&
                            exp.execution?.status === 'success' &&
                            (exp.outcome?.task_progress > 0 || (typeof exp.outcome?.reward === 'number' && exp.outcome.reward >= 0));

    if (isStrictSuccess) {
      if (priority === 'primary') {
        prioritizedCounts.primary += 1;
      } else if (priority === 'fallback') {
        prioritizedCounts.fallback += 1;
      }

      const obsBefore = exp.observation_before || {};
      const agentObs = obsBefore.agent || obsBefore;
      const obsSummary = {
        position: agentObs.position || { x: 0, y: 64, z: 0 },
        health: typeof agentObs.health === 'number' ? agentObs.health : 20,
        food: typeof agentObs.food === 'number' ? agentObs.food : 20,
        inventory: Array.isArray(obsBefore.inventory) ? obsBefore.inventory : [],
        nearby_threats: Array.isArray(obsBefore.nearby_threats) ? obsBefore.nearby_threats : [],
        nearby_resources: Array.isArray(obsBefore.nearby_resources) ? obsBefore.nearby_resources : []
      };

      const systemPrompt = 'You are MIKA, an autonomous Minecraft ALife survival agent. Analyze the current observation, inventory, hazards, and active goal to select the optimal structured action.';
      const userContent = JSON.stringify({
        goal: exp.goal || 'survive and progress',
        environment: exp.environment,
        observation: obsSummary,
        available_actions: exp.available_actions
      });

      const assistantContent = JSON.stringify({
        goal: exp.decision.goal || exp.goal,
        reason_summary: exp.decision.reason_summary,
        action: exp.decision.action,
        arguments: exp.decision.arguments,
        expected_outcome: exp.decision.expected_outcome,
        risk: exp.decision.risk || 'low',
        confidence: exp.decision.confidence || 1.0
      });

      const sftItem = {
        event_id: exp.event_id,
        episode_id: exp.episode_id,
        run_id: exp.run_id,
        step: exp.step,
        instruction: systemPrompt,
        input: userContent,
        output: assistantContent,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
          { role: 'assistant', content: assistantContent }
        ],
        metadata: {
          task_cluster: cluster.clusterId,
          method_id: method.methodId,
          priority: priority,
          training_weight: trainingWeight,
          execution_status: exp.execution?.status,
          failure_detected: false,
          verified_evidence: outcomeVal.evidence,
          reward: Math.max(0, exp.outcome?.reward ?? 0),
          task_progress: exp.outcome?.task_progress ?? 0,
          duration_ms: exp.execution?.duration_ms ?? 0
        }
      };

      sftDemonstrations.push(sftItem);

      actionPredictions.push({
        event_id: exp.event_id,
        episode_id: exp.episode_id,
        run_id: exp.run_id,
        step: exp.step,
        instruction: systemPrompt,
        input: {
          goal: exp.goal,
          environment: exp.environment,
          observation: obsSummary,
          available_actions: exp.available_actions
        },
        target: {
          goal: exp.decision.goal || exp.goal,
          reason_summary: exp.decision.reason_summary,
          action: exp.decision.action,
          arguments: exp.decision.arguments,
          expected_outcome: exp.decision.expected_outcome,
          risk: exp.decision.risk || 'low',
          confidence: exp.decision.confidence || 1.0
        },
        metadata: {
          priority,
          training_weight: trainingWeight,
          execution_status: exp.execution?.status,
          predicted_outcome_met: exp.outcome?.predicted_outcome_met
        }
      });
    }
  }

  // Extract DPO pairs from raw failure and verified corrections
  const dpoPairs = extractDpoPairs(cleanExperiences);

  return {
    sftDemonstrations,
    actionPredictions,
    failureRecovery,
    dpoPairs,
    removedRecords,
    prioritizedCounts
  };
}

/**
 * Runs the complete Task-Aware Dataset Preprocessing pipeline.
 *
 * Implements all 12 Master Requirements:
 * 1. Archive raw datasets first (Req 9).
 * 2. Validate outcomes via game-state evidence (Req 2).
 * 3. Cluster by task, goal, starting conditions, environment (Req 1, 4).
 * 4. Compute metrics per method (Req 3).
 * 5. Prefer faster/leaner methods only when reliability & safety maintained (Req 5).
 * 6. Preserve old successful methods as fallback examples with lower priority (Req 6).
 * 7. Remove corrupted, duplicates, invalid labels, unverified outcomes (Req 7).
 * 8. Preserve failed attempts for recovery with accurate labels (Req 8).
 * 9. Leakage-free train/eval episode split (Req 10).
 * 10. Generate comprehensive report (Req 11).
 *
 * @param {Object} [options={}]
 * @returns {Object} Comprehensive task-aware preprocessing report
 */
export function runTaskAwarePreprocessing(options = {}) {
  const dataDir = options.dataDir || config.storage.dataDir;
  const rawExperiencesPath = options.rawExperiencesPath || path.join(dataDir, 'raw', 'experiences.jsonl');
  const rawFeedbackPath = options.rawFeedbackPath || path.join(dataDir, 'raw', 'feedback.jsonl');
  const processedDir = options.processedDir || path.join(dataDir, 'processed');
  const reportsDir = options.reportsDir || path.join(dataDir, 'reports');
  const evalRatio = options.evalRatio !== undefined ? options.evalRatio : 0.2;

  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  console.log('================================================================');
  console.log('     MIKA TASK-AWARE PREPROCESSING & METHOD PRIORITIZATION       ');
  console.log('================================================================');

  // Step 1: Archive raw datasets before any modification (Requirement 9)
  console.log('[Step 1/6] Archiving raw dataset before processing...');
  const archiveResult = archiveRawDatasets(dataDir, options);
  console.log(`[Archive] Successfully archived ${archiveResult.archivedFiles.length} files to: ${archiveResult.archiveDir}`);

  // Step 2: Parse and normalize raw records
  console.log('[Step 2/6] Parsing and validating raw experience & feedback files...');
  const expParsed = parseJsonlFile(rawExperiencesPath);
  const fbParsed = parseJsonlFile(rawFeedbackPath);
  const feedbackList = fbParsed.records.map(r => r.parsed);

  const cleanExperiences = [];
  const invalidRecords = [];
  const allMetadataCorrections = [];

  for (const item of expParsed.records) {
    const validation = validateAndNormalizeRecord(item.parsed);
    if (validation.valid) {
      cleanExperiences.push(validation.normalized);
      if (validation.metadataCorrections?.length) {
        allMetadataCorrections.push(...validation.metadataCorrections);
      }
    } else {
      invalidRecords.push({
        line: item.line,
        event_id: item.parsed?.event_id || null,
        reasons: validation.errors
      });
    }
  }

  // Link feedback records and identify label anomalies
  linkFeedbackRecords(cleanExperiences, feedbackList);
  const labelAnomalies = detectLabelAnomalies(cleanExperiences, feedbackList);

  // Step 3: Cluster condition contexts and calculate method profiles (Requirements 1, 3, 4)
  console.log('[Step 3/6] Clustering condition contexts & calculating method profiles...');
  const clusterMap = calculateMethodProfiles(cleanExperiences);
  console.log(`[Clustering] Formed ${clusterMap.size} distinct condition clusters.`);

  // Step 4: Rank methods and assign primary vs fallback priorities (Requirements 4, 5, 6)
  console.log('[Step 4/6] Ranking methods (preferring speed/economy ONLY when reliability & safety hold)...');
  const rankedClusters = rankAndPrioritizeMethods(clusterMap, options);

  // Step 5: Filter, sanitize, and prioritize datasets (Requirements 6, 7, 8)
  console.log('[Step 5/6] Filtering datasets: removing unverified/duplicates, preserving fallbacks and recovery lessons...');
  const filtered = filterAndPrioritizeDataset(cleanExperiences, rankedClusters, options);

  // Leakage-free train/eval episode splitting
  const splitSft = splitByEpisode(filtered.sftDemonstrations, evalRatio);
  const splitActions = splitByEpisode(filtered.actionPredictions, evalRatio);
  const splitTransitions = splitByEpisode(cleanExperiences, evalRatio);

  // Write sanitized datasets to disk
  const writeJsonl = (filePath, items) => {
    const content = items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
    fs.writeFileSync(filePath, content, 'utf-8');
  };

  const sftTrainPath = path.join(processedDir, 'sft_chatml_train.jsonl');
  const sftEvalPath = path.join(processedDir, 'sft_chatml_eval.jsonl');
  const failureRecPath = path.join(processedDir, 'failure_recovery.jsonl');
  const dpoPairsPath = path.join(processedDir, 'dpo_pairs.jsonl');
  const trainActionsPath = path.join(processedDir, 'train_actions.jsonl');
  const evalActionsPath = path.join(processedDir, 'eval_actions.jsonl');
  const cleanPath = path.join(processedDir, 'clean_transitions.jsonl');

  writeJsonl(sftTrainPath, splitSft.train);
  writeJsonl(sftEvalPath, splitSft.eval);
  writeJsonl(failureRecPath, filtered.failureRecovery);
  writeJsonl(dpoPairsPath, filtered.dpoPairs);
  writeJsonl(trainActionsPath, splitActions.train);
  writeJsonl(evalActionsPath, splitActions.eval);
  writeJsonl(cleanPath, cleanExperiences);

  // Step 6: Generate detailed report (Requirement 11)
  console.log('[Step 6/6] Generating comprehensive task-aware preprocessing report...');
  const reportPath = path.join(reportsDir, 'task_aware_preprocessing_report.json');

  const clustersReport = [];
  for (const [clusterId, clusterData] of rankedClusters.entries()) {
    clustersReport.push({
      cluster_id: clusterId,
      task_key: clusterData.clusterInfo.taskKey,
      dimension: clusterData.clusterInfo.dimension,
      time_phase: clusterData.clusterInfo.timePhase,
      weather: clusterData.clusterInfo.weather,
      health_bucket: clusterData.clusterInfo.healthBucket,
      threat_status: clusterData.clusterInfo.threatStatus,
      methods_evaluated: clusterData.rankedMethods.map(m => ({
        method_id: m.methodInfo.methodId,
        action: m.methodInfo.action,
        tool: m.methodInfo.tool,
        variant: m.methodInfo.variant,
        attempts: m.attempts,
        verified_successes: m.verified_successes,
        failures: m.failures,
        success_rate: m.success_rate,
        avg_duration_ms: m.avg_duration_ms,
        avg_actions: m.avg_actions,
        avg_damage_taken: m.avg_damage_taken,
        avg_resource_cost: m.avg_resource_cost,
        safety_score: m.safety_score,
        efficiency_score: m.efficiency_score,
        priority: m.priority,
        training_weight: m.training_weight,
        rationale: m.priority_rationale
      }))
    });
  }

  const report = {
    timestamp: new Date().toISOString(),
    archive_manifest: archiveResult,
    source_metrics: {
      raw_experience_lines_read: expParsed.totalLines,
      valid_clean_transitions: cleanExperiences.length,
      invalid_records_rejected: invalidRecords.length,
      syntax_errors_skipped: expParsed.errors.length,
      feedback_records_read: fbParsed.records.length,
      contradictory_labels_found: labelAnomalies.contradictions.length,
      missing_labels_found: labelAnomalies.missingLabels.length,
      metadata_corrections_applied: allMetadataCorrections.length
    },
    filtering_and_prioritization: {
      retained_sft_demonstrations: filtered.sftDemonstrations.length,
      prioritized_breakdown: filtered.prioritizedCounts,
      removed_records: {
        exact_duplicates: filtered.removedRecords.exact_duplicates,
        unverified_outcomes: filtered.removedRecords.unverified_outcomes,
        corrupted_or_invalid: invalidRecords.length + expParsed.errors.length,
        deprioritized_inferior_methods: filtered.removedRecords.deprioritized_inferior,
        total_removed: filtered.removedRecords.exact_duplicates +
                       filtered.removedRecords.unverified_outcomes +
                       invalidRecords.length +
                       expParsed.errors.length +
                       filtered.removedRecords.deprioritized_inferior
      },
      failure_recovery_lessons_preserved: filtered.failureRecovery.length,
      dpo_preference_pairs_extracted: filtered.dpoPairs.length
    },
    splits: {
      train_sft_samples: splitSft.train.length,
      eval_sft_samples: splitSft.eval.length,
      train_episodes: splitSft.trainEpisodes,
      eval_episodes: splitSft.evalEpisodes
    },
    condition_clusters_summary: {
      total_clusters: clustersReport.length,
      clusters: clustersReport
    },
    removed_records_sample: filtered.removedRecords.details.slice(0, 30)
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[Report] Task-aware preprocessing report written to: ${reportPath}`);

  return report;
}

// Auto-run if executed directly via CLI
const isDirectCli = process.argv[1] && (
  process.argv[1].endsWith('task-aware-preprocess.js') ||
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
);

if (isDirectCli) {
  try {
    const report = runTaskAwarePreprocessing();
    console.log(`[Complete] SFT Train: ${report.splits.train_sft_samples}, SFT Eval: ${report.splits.eval_sft_samples}, Clusters: ${report.condition_clusters_summary.total_clusters}, Archived to: ${report.archive_manifest.archiveDir}`);
  } catch (err) {
    console.error('[Error in Task-Aware Preprocessing]', err);
    process.exit(1);
  }
}
