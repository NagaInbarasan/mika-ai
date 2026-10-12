import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';

/**
 * Validates and normalizes an individual experience record.
 * @param {Object} raw - Raw parsed JSON object
 * @returns {{ valid: boolean, errors: string[], normalized: Object|null }}
 */
export function validateAndNormalizeRecord(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Record is not a valid JSON object'], normalized: null };
  }

  // Mandatory fields per Spec Section 5
  if (!raw.event_id || typeof raw.event_id !== 'string') {
    errors.push('Missing or invalid event_id');
  }
  if (!raw.timestamp || typeof raw.timestamp !== 'string') {
    errors.push('Missing or invalid timestamp');
  }
  if (!raw.observation_before || typeof raw.observation_before !== 'object') {
    errors.push('Missing or invalid observation_before object');
  }

  if (errors.length > 0) {
    return { valid: false, errors, normalized: null };
  }

  // Deep clone to prevent mutating raw data
  const normalized = JSON.parse(JSON.stringify(raw));

  // Default metadata
  normalized.schema_version = normalized.schema_version || '1.0';
  normalized.run_id = normalized.run_id || 'run-unknown';
  normalized.episode_id = normalized.episode_id || `ep-${normalized.run_id}`;
  normalized.step = typeof normalized.step === 'number' ? normalized.step : 0;

  // Environment normalization
  normalized.environment = normalized.environment || {};
  normalized.environment.minecraft_version = normalized.environment.minecraft_version || '1.21.11';
  normalized.environment.dimension = normalized.environment.dimension || 'overworld';
  normalized.environment.world_id = normalized.environment.world_id || 'local';

  // Observation before normalization
  const obs = normalized.observation_before;
  obs.agent = obs.agent || {};
  obs.agent.position = obs.agent.position || { x: 0, y: 64, z: 0 };
  obs.agent.position.x = Number(obs.agent.position.x) || 0;
  obs.agent.position.y = Number(obs.agent.position.y) || 64;
  obs.agent.position.z = Number(obs.agent.position.z) || 0;
  obs.agent.health = typeof obs.agent.health === 'number' ? obs.agent.health : 20;
  obs.agent.food = typeof obs.agent.food === 'number' ? obs.agent.food : 20;
  obs.inventory = Array.isArray(obs.inventory) ? obs.inventory : [];
  obs.nearby_threats = Array.isArray(obs.nearby_threats) ? obs.nearby_threats : [];
  obs.nearby_resources = Array.isArray(obs.nearby_resources) ? obs.nearby_resources : [];

  // Decision normalization
  if (normalized.decision) {
    normalized.decision.action = normalized.decision.action || 'stop';
    normalized.decision.arguments = normalized.decision.arguments || {};
    normalized.decision.reason_summary = normalized.decision.reason_summary || '';
    normalized.decision.expected_outcome = normalized.decision.expected_outcome || '';
  }

  // Execution normalization
  normalized.execution = normalized.execution || {};
  normalized.execution.status = normalized.execution.status || 'unknown';
  normalized.execution.duration_ms = typeof normalized.execution.duration_ms === 'number' ? normalized.execution.duration_ms : 0;

  // Outcome normalization
  normalized.outcome = normalized.outcome || {};
  normalized.outcome.task_progress = typeof normalized.outcome.task_progress === 'number' ? normalized.outcome.task_progress : 0;
  normalized.outcome.health_delta = typeof normalized.outcome.health_delta === 'number' ? normalized.outcome.health_delta : 0;
  normalized.outcome.food_delta = typeof normalized.outcome.food_delta === 'number' ? normalized.outcome.food_delta : 0;
  normalized.outcome.resource_delta = normalized.outcome.resource_delta || {};
  normalized.outcome.predicted_outcome_met = typeof normalized.outcome.predicted_outcome_met === 'boolean'
    ? normalized.outcome.predicted_outcome_met
    : false;
  normalized.outcome.reward = typeof normalized.outcome.reward === 'number' ? normalized.outcome.reward : 0;

  // Learning & feedback linkage fields
  normalized.learning = normalized.learning || {};
  normalized.learning.failure_detected = Boolean(normalized.learning.failure_detected);
  normalized.learning.failure_category = normalized.learning.failure_category || null;
  normalized.learning.feedback_event_ids = Array.isArray(normalized.learning.feedback_event_ids)
    ? normalized.learning.feedback_event_ids
    : [];
  normalized.learning.feedback_records = normalized.learning.feedback_records || [];
  normalized.learning.correction_applied = Boolean(normalized.learning.correction_applied);
  normalized.learning.correction_verified = normalized.learning.correction_verified ?? null;

  // Metadata correction & consistency invariants (never allow failed actions to masquerade as success)
  const metadataCorrections = [];
  const isFailed = normalized.execution.status === 'failed' || normalized.execution.status === 'timeout' || Boolean(normalized.learning.failure_detected);

  if (normalized.execution.status === 'failed' && !normalized.learning.failure_detected) {
    normalized.learning.failure_detected = true;
    metadataCorrections.push({
      event_id: normalized.event_id,
      field: 'learning.failure_detected',
      reason: 'Enforced failure_detected=true for failed execution'
    });
  }

  if (isFailed && normalized.outcome.task_progress > 0) {
    metadataCorrections.push({
      event_id: normalized.event_id,
      field: 'outcome.task_progress',
      from: normalized.outcome.task_progress,
      to: 0,
      reason: 'Clamped task_progress to 0 on failed action'
    });
    normalized.outcome.task_progress = 0;
  }

  if (isFailed && normalized.outcome.reward > 0) {
    metadataCorrections.push({
      event_id: normalized.event_id,
      field: 'outcome.reward',
      from: normalized.outcome.reward,
      to: -0.5,
      reason: 'Corrected positive reward to -0.5 on failed action'
    });
    normalized.outcome.reward = -0.5;
  }

  if (isFailed && normalized.outcome.predicted_outcome_met) {
    metadataCorrections.push({
      event_id: normalized.event_id,
      field: 'outcome.predicted_outcome_met',
      reason: 'Set predicted_outcome_met=false on failed action'
    });
    normalized.outcome.predicted_outcome_met = false;
  }

  return { valid: true, errors: [], normalized, metadataCorrections };
}

/**
 * Safely parses a JSONL file into an array of lines/records, tracking syntax errors and duplicates.
 * @param {string} filePath 
 * @returns {{ records: Object[], errors: Object[], totalLines: number, duplicates: number }}
 */
export function parseJsonlFile(filePath) {
  const records = [];
  const errors = [];
  const seenEventIds = new Set();
  let duplicates = 0;
  let totalLines = 0;

  if (!fs.existsSync(filePath)) {
    return { records, errors, totalLines, duplicates };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue; // Skip blank lines

    totalLines++;
    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch (err) {
      errors.push({
        line: i + 1,
        raw: rawLine.slice(0, 100),
        reason: `JSON parse error: ${err.message}`
      });
      continue;
    }

    if (parsed.event_id && seenEventIds.has(parsed.event_id)) {
      duplicates++;
      continue; // Skip duplicate records
    }

    if (parsed.event_id) {
      seenEventIds.add(parsed.event_id);
    }

    records.push({ parsed, line: i + 1 });
  }

  return { records, errors, totalLines, duplicates };
}

/**
 * Links feedback and correction records to their respective experience events.
 * @param {Object[]} experiences - Array of normalized experience objects
 * @param {Object[]} feedbackRecords - Array of raw parsed feedback objects
 * @returns {number} Count of linked feedback associations
 */
export function linkFeedbackRecords(experiences, feedbackRecords) {
  let linkedCount = 0;

  // Build lookup maps
  const expById = new Map();
  const expByStep = new Map();

  for (const exp of experiences) {
    expById.set(exp.event_id, exp);
    const stepKey = `${exp.run_id}:${exp.episode_id}:${exp.step}`;
    expByStep.set(stepKey, exp);
  }

  for (const fb of feedbackRecords) {
    let targetExp = null;

    if (fb.related_event_id && expById.has(fb.related_event_id)) {
      targetExp = expById.get(fb.related_event_id);
    } else {
      // Fallback matching by run, episode, and step
      const stepKey = `${fb.run_id}:${fb.episode_id}:${fb.step}`;
      if (expByStep.has(stepKey)) {
        targetExp = expByStep.get(stepKey);
      }
    }

    if (targetExp) {
      if (!targetExp.learning) {
        targetExp.learning = {};
      }
      if (!Array.isArray(targetExp.learning.feedback_event_ids)) {
        targetExp.learning.feedback_event_ids = [];
      }
      if (!Array.isArray(targetExp.learning.feedback_records)) {
        targetExp.learning.feedback_records = [];
      }
      if (!targetExp.learning.feedback_event_ids.includes(fb.event_id)) {
        targetExp.learning.feedback_event_ids.push(fb.event_id);
      }
      targetExp.learning.feedback_records.push({
        event_id: fb.event_id,
        event_type: fb.event_type,
        label: fb.label,
        feedback_text: fb.feedback_text || null,
        correction_proposed: fb.correction_proposed || null,
        retry_result: fb.retry_result || null
      });

      if (fb.event_type === 'correction') {
        targetExp.learning.correction_applied = true;
        targetExp.learning.correction_verified = fb.retry_result === 'success';
      }

      linkedCount++;
    }
  }

  return linkedCount;
}

/**
 * Identifies contradictory and missing labels across experiences and feedback.
 * Enforces data cleanliness standards before model fine-tuning.
 * @param {Object[]} experiences 
 * @param {Object[]} feedbackRecords 
 * @returns {{ contradictions: Object[], missingLabels: Object[] }}
 */
export function detectLabelAnomalies(experiences, feedbackRecords = []) {
  const contradictions = [];
  const missingLabels = [];

  // 1. Missing labels in feedback
  for (const fb of feedbackRecords) {
    if (!fb.label || String(fb.label).trim() === '') {
      missingLabels.push({
        event_id: fb.event_id,
        related_event_id: fb.related_event_id || null,
        source: 'feedback',
        reason: 'Feedback record has missing or null label',
        feedback_text: fb.feedback_text || null
      });
    }
  }

  // 2. Contradictory labels in linked experiences
  for (const exp of experiences) {
    const isExecutionFailed = exp.execution?.status === 'failed' || exp.execution?.status === 'timeout' || Boolean(exp.learning?.failure_detected);
    const feedbackList = exp.learning?.feedback_records || [];
    const labels = feedbackList.map(f => f.label).filter(Boolean);

    // Contradiction A: Failure marked positive
    if (isExecutionFailed && labels.includes('positive')) {
      contradictions.push({
        event_id: exp.event_id,
        type: 'failure_marked_positive',
        reason: `Failed action '${exp.decision?.action || 'unknown'}' has contradictory positive feedback label`,
        execution_status: exp.execution?.status,
        feedback_labels: labels
      });
    }

    // Contradiction B: Success marked negative
    if (!isExecutionFailed && exp.execution?.status === 'success' && labels.includes('negative')) {
      contradictions.push({
        event_id: exp.event_id,
        type: 'success_marked_negative',
        reason: `Successful action '${exp.decision?.action || 'unknown'}' has negative human feedback`,
        execution_status: exp.execution?.status,
        feedback_labels: labels
      });
    }

    // Contradiction C: Multiple contradictory feedback records on same event
    if (labels.includes('positive') && labels.includes('negative')) {
      contradictions.push({
        event_id: exp.event_id,
        type: 'conflicting_feedback_labels',
        reason: `Contradictory feedback records (both positive and negative) linked to event`,
        feedback_labels: labels
      });
    }

    // Contradiction D: Execution status failed but reward > 0 or task_progress > 0
    if (isExecutionFailed && ((exp.outcome?.reward || 0) > 0 || (exp.outcome?.task_progress || 0) > 0)) {
      contradictions.push({
        event_id: exp.event_id,
        type: 'failed_action_positive_outcome',
        reason: `Action execution failed but record contains positive outcome reward/progress`,
        execution_status: exp.execution?.status,
        reward: exp.outcome?.reward,
        task_progress: exp.outcome?.task_progress
      });
    }
  }

  return { contradictions, missingLabels };
}

/**
 * Generates distinct specialized datasets for future model fine-tuning and evaluation.
 * @param {Object[]} experiences - Normalized and linked experiences
 * @returns {Object} Datasets object containing action, outcome, and recovery records
 */
export function generateSpecializedDatasets(experiences) {
  const actionPrediction = [];
  const outcomePrediction = [];
  const failureRecovery = [];
  const sftDemonstrations = [];

  for (const exp of experiences) {
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

    // 1. Action Prediction Dataset (Instruction / Decision modeling)
    if (exp.decision && exp.decision.action) {
      actionPrediction.push({
        event_id: exp.event_id,
        episode_id: exp.episode_id,
        run_id: exp.run_id,
        step: exp.step,
        instruction: `You are MIKA, an autonomous Minecraft ALife agent. Given the current observation and goal, choose the optimal next action.`,
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
          execution_status: exp.execution?.status,
          predicted_outcome_met: exp.outcome?.predicted_outcome_met,
          feedback_labels: (exp.learning?.feedback_records || []).map(f => f.label)
        }
      });
    }

    // 2. Outcome Prediction Dataset (World Model Dynamics)
    if (exp.decision && exp.outcome) {
      outcomePrediction.push({
        event_id: exp.event_id,
        episode_id: exp.episode_id,
        run_id: exp.run_id,
        input: {
          agent_state: {
            position: obsSummary.position,
            health: obsSummary.health,
            food: obsSummary.food,
            inventory: obsSummary.inventory
          },
          action: exp.decision.action,
          arguments: exp.decision.arguments
        },
        target: {
          execution_status: exp.execution?.status,
          health_delta: exp.outcome?.health_delta,
          food_delta: exp.outcome?.food_delta,
          resource_delta: exp.outcome?.resource_delta,
          damage_taken: exp.outcome?.damage_taken || 0,
          task_progress: exp.outcome?.task_progress,
          predicted_outcome_met: exp.outcome?.predicted_outcome_met
        }
      });
    }

    // 3. Failure & Recovery Dataset (Mistake Diagnostics and Correction)
    if (exp.learning?.failure_detected || exp.execution?.status === 'failed' || exp.learning?.correction_applied) {
      failureRecovery.push({
        event_id: exp.event_id,
        episode_id: exp.episode_id,
        run_id: exp.run_id,
        failed_state: {
          goal: exp.goal,
          observation: exp.observation_before,
          attempted_action: exp.decision?.action || 'unknown',
          arguments: exp.decision?.arguments || {},
          error_message: exp.execution?.error || exp.execution?.error_code
        },
        failure_category: exp.learning?.failure_category || 'unknown',
        linked_feedback: exp.learning?.feedback_records || [],
        correction: {
          correction_applied: exp.learning?.correction_applied,
          correction_verified: exp.learning?.correction_verified
        }
      });
    }

    // 4. High-Quality SFT Demonstration Dataset (Filtering out failures for behavioral cloning)
    const isExecutionFailed = exp.execution?.status === 'failed' || exp.execution?.status === 'timeout';
    const isFailureDetected = Boolean(exp.learning?.failure_detected);
    const hasNegativeFeedback = exp.learning?.feedback_records?.some(f => f.label === 'negative');
    const isNegativeReward = typeof exp.outcome?.reward === 'number' && exp.outcome.reward < 0;

    // Invariant: Never silently convert failed actions into successful examples
    const isStrictSuccess = !isExecutionFailed && !isFailureDetected && !hasNegativeFeedback && !isNegativeReward &&
                            exp.execution?.status === 'success' &&
                            (exp.outcome?.task_progress > 0 || (typeof exp.outcome?.reward === 'number' && exp.outcome.reward >= 0));

    if (exp.decision && exp.decision.action && isStrictSuccess) {
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

      sftDemonstrations.push({
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
          reward: exp.outcome?.reward ?? 0,
          task_progress: exp.outcome?.task_progress ?? 0,
          duration_ms: exp.execution.duration_ms
        }
      });
    }
  }

  // 5. Contrastive / DPO Preference Pairs (Chosen correction vs Rejected failure)
  const dpoPairs = extractDpoPairs(experiences);

  return {
    actionPrediction,
    outcomePrediction,
    failureRecovery,
    sftDemonstrations,
    dpoPairs
  };
}

/**
 * Extracts contrastive preference pairs (chosen vs rejected) from failed actions and linked corrections.
 * @param {Object[]} experiences 
 * @returns {Object[]}
 */
export function extractDpoPairs(experiences) {
  const pairs = [];

  for (const exp of experiences) {
    const feedbackRecords = exp.learning?.feedback_records || [];
    const corrections = feedbackRecords.filter(f => f.event_type === 'correction' && f.correction_proposed);

    for (const corr of corrections) {
      if (exp.decision && exp.decision.action) {
        pairs.push({
          event_id: exp.event_id,
          episode_id: exp.episode_id,
          run_id: exp.run_id,
          step: exp.step,
          prompt: `Goal: ${exp.goal || 'survive'}. Current state: HP ${exp.observation_before?.agent?.health ?? 20}, Food ${exp.observation_before?.agent?.food ?? 20}, Position ${JSON.stringify(exp.observation_before?.agent?.position || {})}`,
          chosen: {
            action: corr.correction_proposed,
            reason: `Verified correction: resolved previous ${exp.learning?.failure_category || 'mistake'}`
          },
          rejected: {
            action: exp.decision.action,
            arguments: exp.decision.arguments || {},
            reason: exp.execution?.error || `Action failed with ${exp.execution?.error_code || 'error'}`
          },
          metadata: {
            failure_category: exp.learning?.failure_category,
            retry_result: corr.retry_result
          }
        });
      }
    }
  }

  return pairs;
}

/**
 * Disambiguates episode identifiers across multiple runs.
 * @param {Object} exp 
 * @returns {string}
 */
export function getEpisodeKey(exp) {
  if (exp && exp.run_id && exp.episode_id && !exp.episode_id.startsWith(exp.run_id)) {
    return `${exp.run_id}:${exp.episode_id}`;
  }
  return exp?.episode_id || exp?.run_id || 'ep-default';
}

/**
 * Splits records into Train and Eval sets by Episode ID
 * to strictly prevent adjacent-step leakage across splits.
 * @param {Object[]} records 
 * @param {number} [evalRatio=0.2]
 * @returns {{ train: Object[], eval: Object[], trainEpisodes: string[], evalEpisodes: string[] }}
 */
export function splitByEpisode(records, evalRatio = 0.2) {
  // Collect unique episodes
  const episodeMap = new Map();
  for (const item of records) {
    const epId = getEpisodeKey(item);
    if (!episodeMap.has(epId)) {
      episodeMap.set(epId, []);
    }
    episodeMap.get(epId).push(item);
  }

  const episodeIds = Array.from(episodeMap.keys());

  // Deterministic split: sorted by ID
  episodeIds.sort();

  const evalCount = Math.max(1, Math.round(episodeIds.length * evalRatio));
  // If only 1 episode exists, keep it in train and create empty eval or duplicate-free marker
  const evalEpisodes = episodeIds.length > 1 ? episodeIds.slice(-evalCount) : [];
  const evalSet = new Set(evalEpisodes);

  const trainEpisodes = episodeIds.filter(id => !evalSet.has(id));

  const train = [];
  const evaluation = [];

  for (const item of records) {
    const epId = getEpisodeKey(item);
    if (evalSet.has(epId)) {
      evaluation.push(item);
    } else {
      train.push(item);
    }
  }

  return {
    train,
    eval: evaluation,
    trainEpisodes,
    evalEpisodes
  };
}

/**
 * Executes the complete preprocessing and filtering pipeline.
 * @param {Object} [options={}]
 * @returns {Object} Quality summary report
 */
export function runPreprocessing(options = {}) {
  const dataDir = options.dataDir || config.storage.dataDir;
  const rawExperiencesPath = options.rawExperiencesPath || path.join(dataDir, 'raw', 'experiences.jsonl');
  const rawFeedbackPath = options.rawFeedbackPath || path.join(dataDir, 'raw', 'feedback.jsonl');
  const processedDir = options.processedDir || path.join(dataDir, 'processed');
  const reportsDir = options.reportsDir || path.join(dataDir, 'reports');
  const evalRatio = options.evalRatio !== undefined ? options.evalRatio : 0.2;

  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  console.log(`[Preprocessing] Reading raw experiences from: ${rawExperiencesPath}`);
  const expParsed = parseJsonlFile(rawExperiencesPath);
  console.log(`[Preprocessing] Parsed ${expParsed.records.length} records (${expParsed.duplicates} duplicates, ${expParsed.errors.length} syntax errors)`);

  console.log(`[Preprocessing] Reading raw feedback from: ${rawFeedbackPath}`);
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

  // Link feedback records
  const linkedFeedbackCount = linkFeedbackRecords(cleanExperiences, feedbackList);
  console.log(`[Preprocessing] Linked ${linkedFeedbackCount} feedback/correction events`);

  // Identify contradictory and missing labels
  const anomalies = detectLabelAnomalies(cleanExperiences, feedbackList);
  console.log(`[Preprocessing] Found ${anomalies.contradictions.length} contradictory labels, ${anomalies.missingLabels.length} missing labels, ${allMetadataCorrections.length} metadata corrections`);

  // Generate specialized datasets (action, outcome, failure recovery, SFT demonstrations, DPO pairs)
  const datasets = generateSpecializedDatasets(cleanExperiences);

  // Leakage-free Episode Splits
  const splitTransitions = splitByEpisode(cleanExperiences, evalRatio);
  const splitActions = splitByEpisode(datasets.actionPrediction, evalRatio);
  const splitSft = splitByEpisode(datasets.sftDemonstrations, evalRatio);

  // Output Paths
  const cleanPath = path.join(processedDir, 'clean_transitions.jsonl');
  const actionPredPath = path.join(processedDir, 'action_prediction.jsonl');
  const outcomePredPath = path.join(processedDir, 'outcome_prediction.jsonl');
  const failureRecPath = path.join(processedDir, 'failure_recovery.jsonl');
  const dpoPairsPath = path.join(processedDir, 'dpo_pairs.jsonl');

  // Baseline train/eval transitions
  const trainPath = path.join(processedDir, 'train.jsonl');
  const evalPath = path.join(processedDir, 'eval.jsonl');

  // Dedicated model training datasets
  const trainActionsPath = path.join(processedDir, 'train_actions.jsonl');
  const evalActionsPath = path.join(processedDir, 'eval_actions.jsonl');
  const sftChatmlTrainPath = path.join(processedDir, 'sft_chatml_train.jsonl');
  const sftChatmlEvalPath = path.join(processedDir, 'sft_chatml_eval.jsonl');

  const reportPath = path.join(reportsDir, 'preprocessing_report.json');

  // Helper write function
  const writeJsonl = (filePath, items) => {
    const content = items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
    fs.writeFileSync(filePath, content, 'utf-8');
  };

  writeJsonl(cleanPath, cleanExperiences);
  writeJsonl(actionPredPath, datasets.actionPrediction);
  writeJsonl(outcomePredPath, datasets.outcomePrediction);
  writeJsonl(failureRecPath, datasets.failureRecovery);
  writeJsonl(dpoPairsPath, datasets.dpoPairs);

  writeJsonl(trainPath, splitTransitions.train);
  writeJsonl(evalPath, splitTransitions.eval);

  writeJsonl(trainActionsPath, splitActions.train);
  writeJsonl(evalActionsPath, splitActions.eval);
  writeJsonl(sftChatmlTrainPath, splitSft.train);
  writeJsonl(sftChatmlEvalPath, splitSft.eval);

  const report = {
    timestamp: new Date().toISOString(),
    source_files: {
      experiences: rawExperiencesPath,
      feedback: rawFeedbackPath
    },
    metrics: {
      total_experience_lines_read: expParsed.totalLines,
      valid_clean_transitions: cleanExperiences.length,
      invalid_records_rejected: invalidRecords.length,
      syntax_errors_skipped: expParsed.errors.length,
      duplicate_records_skipped: expParsed.duplicates,
      feedback_records_read: fbParsed.records.length,
      feedback_records_linked: linkedFeedbackCount,
      contradictory_labels_found: anomalies.contradictions.length,
      missing_labels_found: anomalies.missingLabels.length,
      metadata_corrections_applied: allMetadataCorrections.length,
      passive_observations_filtered: cleanExperiences.length - datasets.actionPrediction.length
    },
    specialized_datasets: {
      action_prediction_samples: datasets.actionPrediction.length,
      outcome_prediction_samples: datasets.outcomePrediction.length,
      failure_recovery_samples: datasets.failureRecovery.length,
      sft_demonstration_samples: datasets.sftDemonstrations.length,
      dpo_preference_pairs: datasets.dpoPairs.length
    },
    episode_split: {
      total_episodes: splitTransitions.trainEpisodes.length + splitTransitions.evalEpisodes.length,
      train_episodes_count: splitTransitions.trainEpisodes.length,
      eval_episodes_count: splitTransitions.evalEpisodes.length,
      train_records_count: splitTransitions.train.length,
      eval_records_count: splitTransitions.eval.length,
      train_episode_ids: splitTransitions.trainEpisodes,
      eval_episode_ids: splitTransitions.evalEpisodes,
      model_training_split: {
        train_action_samples: splitActions.train.length,
        eval_action_samples: splitActions.eval.length,
        train_sft_samples: splitSft.train.length,
        eval_sft_samples: splitSft.eval.length
      }
    },
    anomalies: {
      contradictions: anomalies.contradictions,
      missing_labels: anomalies.missingLabels,
      metadata_corrections: allMetadataCorrections.slice(0, 50)
    },
    rejected_records_detail: invalidRecords.slice(0, 50),
    syntax_errors_detail: expParsed.errors.slice(0, 50)
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[Preprocessing] Report written to: ${reportPath}`);
  console.log(`[Preprocessing] Processed datasets written to: ${processedDir}`);

  return report;
}

// Re-export task-aware preprocessing functions
export {
  archiveRawDatasets,
  validateOutcomeEvidence,
  extractConditionCluster,
  extractMethodSignature,
  calculateMethodProfiles,
  rankAndPrioritizeMethods,
  filterAndPrioritizeDataset,
  runTaskAwarePreprocessing
} from './task-aware-preprocess.js';

// Auto-run if executed via CLI
const isDirectCli = process.argv[1] && (
  process.argv[1].endsWith('preprocess.js') ||
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
);

if (isDirectCli) {
  try {
    const report = runPreprocessing();
    console.log(`[Preprocessing Complete] Clean: ${report.metrics.valid_clean_transitions}, Filtered Actions: ${report.specialized_datasets.action_prediction_samples}, SFT Demos: ${report.specialized_datasets.sft_demonstration_samples}, Train: ${report.episode_split.train_records_count}, Eval: ${report.episode_split.eval_records_count}`);
  } catch (err) {
    console.error(`[Preprocessing Error]`, err);
    process.exit(1);
  }
}

