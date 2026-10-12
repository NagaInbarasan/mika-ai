import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import config from '../config/index.js';
import { runPreprocessing, parseJsonlFile } from '../data/preprocess.js';
import { runTaskAwarePreprocessing } from '../data/task-aware-preprocess.js';
import defaultMemoryStore from '../learning/memory.js';

export async function runAutonomousPipeline(options = {}) {
  const startTime = Date.now();
  const dataDir = options.dataDir || config.storage.dataDir;
  const reportsDir = path.join(dataDir, 'reports');
  const modelsDir = path.join(dataDir, 'models');
  const pipelineReportPath = path.join(reportsDir, 'pipeline_report.json');

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });

  console.log('================================================================');
  console.log('        MIKA AUTONOMOUS END-TO-END LEARNING PIPELINE            ');
  console.log('================================================================');

  const pipelineReport = {
    pipeline_version: '1.0.0',
    timestamp: new Date().toISOString(),
    status: 'running',
    phases: {},
    dataset_counts: {},
    anomalies: {},
    persistent_learning: {},
    training_metrics: null,
    evaluation_results: null,
    model_deployment: null,
    resource_usage: {},
    errors: []
  };

  if (options.rollback) {
    console.log('[Rollback] Fast rollback requested. Reverting active model version...');
    const deployScript = path.resolve('src/train/deploy.py');
    const registryPath = path.join(modelsDir, 'registry.json');
    const pythonExe = options.pythonExe || 'py';
    const pythonArgs = options.pythonExe ? [] : ['-3.10'];
    const rollbackArgs = [...pythonArgs, deployScript, '--rollback', '--registry-file', registryPath];
    if (options.targetVersion) {
      rollbackArgs.push('--target-version', options.targetVersion);
    }
    let existingReport = {};
    if (fs.existsSync(pipelineReportPath)) {
      try { existingReport = JSON.parse(fs.readFileSync(pipelineReportPath, 'utf-8')); } catch (_) {}
    }

    const mergedReport = {
      ...existingReport,
      last_rollback_timestamp: new Date().toISOString(),
      status: proc.status === 0 ? 'rollback_success' : 'rollback_failed'
    };
    if (fs.existsSync(registryPath)) {
      mergedReport.model_deployment = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    }
    fs.writeFileSync(pipelineReportPath, JSON.stringify(mergedReport, null, 2), 'utf-8');
    return mergedReport;
  }

  try {
    // ---------------------------------------------------------
    // Phase 1: Collect & Clean Data (Task-Aware Preprocessing & Archiving)
    // ---------------------------------------------------------
    console.log('\n[Phase 1/6] CLEANING, ARCHIVING & TASK-AWARE PREPROCESSING EXPERIENCES...');
    const phase1Start = Date.now();
    let preprocessReport;

    if (options.taskAware !== false) {
      preprocessReport = runTaskAwarePreprocessing({
        dataDir,
        evalRatio: options.evalRatio ?? 0.2
      });
      pipelineReport.phases.preprocessing_ms = Date.now() - phase1Start;
      pipelineReport.dataset_counts = {
        raw_experience_lines: preprocessReport.source_metrics.raw_experience_lines_read,
        clean_transitions: preprocessReport.source_metrics.valid_clean_transitions,
        invalid_records_rejected: preprocessReport.source_metrics.invalid_records_rejected,
        raw_feedback_records: preprocessReport.source_metrics.feedback_records_read,
        linked_feedback_events: preprocessReport.source_metrics.feedback_records_read,
        sft_demonstrations_samples: preprocessReport.filtering_and_prioritization.retained_sft_demonstrations,
        train_sft_samples: preprocessReport.splits.train_sft_samples,
        eval_sft_samples: preprocessReport.splits.eval_sft_samples,
        dpo_preference_pairs: preprocessReport.filtering_and_prioritization.dpo_preference_pairs_extracted,
        failure_recovery_lessons: preprocessReport.filtering_and_prioritization.failure_recovery_lessons_preserved,
        prioritized_breakdown: preprocessReport.filtering_and_prioritization.prioritized_breakdown,
        removed_records: preprocessReport.filtering_and_prioritization.removed_records
      };
      pipelineReport.anomalies = {
        contradictory_labels_found: preprocessReport.source_metrics.contradictory_labels_found,
        missing_labels_found: preprocessReport.source_metrics.missing_labels_found,
        metadata_corrections_applied: preprocessReport.source_metrics.metadata_corrections_applied
      };
      pipelineReport.task_aware_prioritization = {
        archive_dir: preprocessReport.archive_manifest.archiveDir,
        total_clusters: preprocessReport.condition_clusters_summary.total_clusters,
        prioritized_breakdown: preprocessReport.filtering_and_prioritization.prioritized_breakdown
      };
    } else {
      preprocessReport = runPreprocessing({
        dataDir,
        evalRatio: options.evalRatio ?? 0.2
      });
      pipelineReport.phases.preprocessing_ms = Date.now() - phase1Start;
      pipelineReport.dataset_counts = {
        raw_experience_lines: preprocessReport.metrics.total_experience_lines_read,
        clean_transitions: preprocessReport.metrics.valid_clean_transitions,
        invalid_records_rejected: preprocessReport.metrics.invalid_records_rejected,
        raw_feedback_records: preprocessReport.metrics.feedback_records_read,
        linked_feedback_events: preprocessReport.metrics.feedback_records_linked,
        sft_demonstrations_samples: preprocessReport.specialized_datasets.sft_demonstration_samples,
        action_prediction_samples: preprocessReport.specialized_datasets.action_prediction_samples,
        dpo_preference_pairs: preprocessReport.specialized_datasets.dpo_preference_pairs,
        train_episodes: preprocessReport.episode_split.train_episodes_count,
        eval_episodes: preprocessReport.episode_split.eval_episodes_count,
        train_sft_samples: preprocessReport.episode_split.model_training_split.train_sft_samples,
        eval_sft_samples: preprocessReport.episode_split.model_training_split.eval_sft_samples
      };
      pipelineReport.anomalies = {
        contradictory_labels_found: preprocessReport.metrics.contradictory_labels_found,
        missing_labels_found: preprocessReport.metrics.missing_labels_found,
        metadata_corrections_applied: preprocessReport.metrics.metadata_corrections_applied,
        detail: preprocessReport.anomalies
      };
    }

    console.log(`[Phase 1] Complete: ${pipelineReport.dataset_counts.clean_transitions} clean transitions, ` +
                `${pipelineReport.anomalies.contradictory_labels_found} contradictory labels identified, ` +
                `${pipelineReport.anomalies.missing_labels_found} missing labels identified, ` +
                `${pipelineReport.dataset_counts.sft_demonstrations_samples} pure SFT demonstrations.`);

    // ---------------------------------------------------------
    // Phase 2: Learn (Persistent Skill Memory & Recovery Rules)
    // ---------------------------------------------------------
    console.log('\n[Phase 2/6] UPDATING PERSISTENT SKILL MEMORY & RECOVERY RULES...');
    const phase2Start = Date.now();

    const cleanTransitionsPath = path.join(dataDir, 'processed', 'clean_transitions.jsonl');
    const rawFeedbackPath = path.join(dataDir, 'raw', 'feedback.jsonl');

    const cleanExps = parseJsonlFile(cleanTransitionsPath).records.map(r => r.parsed);
    const rawFbs = parseJsonlFile(rawFeedbackPath).records.map(r => r.parsed);

    const memoryLearningResult = defaultMemoryStore.learnFromDataset({
      experiences: cleanExps,
      feedbackRecords: rawFbs
    });

    pipelineReport.phases.persistent_learning_ms = Date.now() - phase2Start;
    pipelineReport.persistent_learning = memoryLearningResult;

    console.log(`[Phase 2] Complete: Ingested ${memoryLearningResult.correctionsIngested} recovery corrections, ` +
                `${memoryLearningResult.lessonsLearned} survival lessons, ` +
                `${memoryLearningResult.strategiesUpdated} task strategies into persistent memory.`);

    // ---------------------------------------------------------
    // Phase 3: Quality Gate Verification for Training
    // ---------------------------------------------------------
    console.log('\n[Phase 3/6] VERIFYING TRAINING QUALITY GATES...');
    const minSamples = options.minSamples ?? 10;
    const trainSftPath = path.join(dataDir, 'processed', 'sft_chatml_train.jsonl');
    const evalSftPath = path.join(dataDir, 'processed', 'sft_chatml_eval.jsonl');

    let qualityGatePassed = true;
    const qualityGateIssues = [];

    if (!fs.existsSync(trainSftPath) || fs.statSync(trainSftPath).size === 0) {
      qualityGatePassed = false;
      qualityGateIssues.push('Training dataset file is missing or empty');
    }
    if (!fs.existsSync(evalSftPath) || fs.statSync(evalSftPath).size === 0) {
      qualityGatePassed = false;
      qualityGateIssues.push('Evaluation dataset file is missing or empty');
    }
    if (pipelineReport.dataset_counts.train_sft_samples < minSamples && !options.forceTrain) {
      qualityGatePassed = false;
      qualityGateIssues.push(`Train sample count (${pipelineReport.dataset_counts.train_sft_samples}) below threshold (${minSamples})`);
    }

    if (!qualityGatePassed) {
      console.warn(`[Quality Gate FAILED] Training aborted: ${qualityGateIssues.join(', ')}`);
      pipelineReport.errors.push(...qualityGateIssues);
      pipelineReport.status = 'quality_gate_rejected';
      fs.writeFileSync(pipelineReportPath, JSON.stringify(pipelineReport, null, 2), 'utf-8');
      return pipelineReport;
    }
    console.log('[Quality Gate PASSED] Dataset meets all criteria. Eligible for fine-tuning.');

    // ---------------------------------------------------------
    // Phase 4: Train (Python LoRA Fine-Tuning)
    // ---------------------------------------------------------
    console.log('\n[Phase 4/6] EXECUTING LIGHTWEIGHT LORA TRAINING IN PYTHON...');
    const phase4Start = Date.now();
    const trainScript = path.resolve('src/train/train.py');
    const checkpointsDir = path.join(modelsDir, 'checkpoints');
    const trainReportPath = path.join(reportsDir, 'training_report.json');

    const epochs = options.epochs ?? 4;
    const batchSize = options.batchSize ?? 8;
    const loraR = options.loraR ?? 8;
    const loraAlpha = options.loraAlpha ?? 16;
    const maxVramMb = options.maxVramMb ?? 6000;
    const pythonExe = options.pythonExe || 'py';
    const pythonArgs = options.pythonExe ? [] : ['-3.10'];

    const trainCmdArgs = [
      ...pythonArgs,
      trainScript,
      '--train-file', trainSftPath,
      '--eval-file', evalSftPath,
      '--output-dir', checkpointsDir,
      '--report-file', trainReportPath,
      '--epochs', String(epochs),
      '--batch-size', String(batchSize),
      '--lora-r', String(loraR),
      '--lora-alpha', String(loraAlpha),
      '--max-vram-mb', String(maxVramMb)
    ];

    console.log(`[Train Command] ${pythonExe} ${trainCmdArgs.join(' ')}`);
    const trainProc = spawnSync(pythonExe, trainCmdArgs, { stdio: 'inherit', encoding: 'utf-8' });

    pipelineReport.phases.training_ms = Date.now() - phase4Start;

    if (trainProc.status !== 0) {
      const err = `Training process exited with code ${trainProc.status}`;
      console.error(`[Phase 4 Error] ${err}`);
      pipelineReport.errors.push(err);
      pipelineReport.status = 'training_failed';
      fs.writeFileSync(pipelineReportPath, JSON.stringify(pipelineReport, null, 2), 'utf-8');
      return pipelineReport;
    }

    if (fs.existsSync(trainReportPath)) {
      pipelineReport.training_metrics = JSON.parse(fs.readFileSync(trainReportPath, 'utf-8'));
    }

    console.log('[Phase 4] Training completed successfully.');

    // ---------------------------------------------------------
    // Phase 5: Evaluate Candidate Model Against Baseline
    // ---------------------------------------------------------
    console.log('\n[Phase 5/6] EVALUATING CANDIDATE MODEL ON UNSEEN SCENARIOS...');
    const phase5Start = Date.now();
    const evalScript = path.resolve('src/train/evaluate.py');
    const bestModelPath = path.join(checkpointsDir, 'best_model.pt');
    const evalReportPath = path.join(reportsDir, 'evaluation_report.json');

    const evalCmdArgs = [
      ...pythonArgs,
      evalScript,
      '--candidate-checkpoint', bestModelPath,
      '--eval-file', evalSftPath,
      '--report-file', evalReportPath,
      '--baseline-loss', String(options.baselineLoss ?? 4.5),
      '--baseline-accuracy', String(options.baselineAccuracy ?? 0.20)
    ];

    const evalProc = spawnSync(pythonExe, evalCmdArgs, { stdio: 'inherit', encoding: 'utf-8' });
    pipelineReport.phases.evaluation_ms = Date.now() - phase5Start;

    if (evalProc.status !== 0) {
      pipelineReport.errors.push(`Evaluation process failed with code ${evalProc.status}`);
    }

    let isAccepted = false;
    if (fs.existsSync(evalReportPath)) {
      const evalData = JSON.parse(fs.readFileSync(evalReportPath, 'utf-8'));
      pipelineReport.evaluation_results = evalData;
      isAccepted = evalData.acceptance?.accepted ?? false;
    }

    console.log(`[Phase 5] Evaluation complete. Acceptance Decision: ${isAccepted ? 'ACCEPTED' : 'REJECTED'}`);

    // ---------------------------------------------------------
    // Phase 6: Deploy (Only if Acceptance Criteria Passed)
    // ---------------------------------------------------------
    console.log('\n[Phase 6/6] MODEL DEPLOYMENT & VERSIONING...');
    const phase6Start = Date.now();
    const deployScript = path.resolve('src/train/deploy.py');
    const registryPath = path.join(modelsDir, 'registry.json');

    if (options.rollback) {
      console.log('[Deployment] Rollback requested.');
      const rollbackArgs = [...pythonArgs, deployScript, '--rollback', '--registry-file', registryPath];
      if (options.targetVersion) {
        rollbackArgs.push('--target-version', options.targetVersion);
      }
      spawnSync(pythonExe, rollbackArgs, { stdio: 'inherit' });
    } else if (isAccepted) {
      console.log('[Deployment] Candidate model passed evaluation. Deploying new version...');
      const deployCmdArgs = [
        ...pythonArgs,
        deployScript,
        '--deploy', bestModelPath,
        '--eval-report', evalReportPath,
        '--registry-file', registryPath
      ];
      const deployProc = spawnSync(pythonExe, deployCmdArgs, { stdio: 'inherit' });
      if (deployProc.status !== 0) {
        pipelineReport.errors.push(`Deployment script failed with code ${deployProc.status}`);
      }
    } else {
      console.log('[Deployment] Candidate rejected. Active working bot model kept unchanged.');
    }

    pipelineReport.phases.deployment_ms = Date.now() - phase6Start;

    // Load final registry state
    if (fs.existsSync(registryPath)) {
      pipelineReport.model_deployment = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    }

    // ---------------------------------------------------------
    // Pipeline Summary & Reporting
    // ---------------------------------------------------------
    const totalDuration = Date.now() - startTime;
    pipelineReport.status = isAccepted ? 'completed_deployed' : 'completed_candidate_rejected';
    pipelineReport.resource_usage = {
      total_duration_ms: totalDuration,
      total_duration_seconds: roundNumber(totalDuration / 1000, 2),
      peak_vram_mb: pipelineReport.training_metrics?.peak_vram_mb ?? 0
    };

    fs.writeFileSync(pipelineReportPath, JSON.stringify(pipelineReport, null, 2), 'utf-8');

    console.log('\n================================================================');
    console.log('            MIKA AUTONOMOUS PIPELINE SUMMARY REPORT              ');
    console.log('================================================================');
    console.log(`Status               : ${pipelineReport.status}`);
    console.log(`Total Duration       : ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`Clean Transitions    : ${pipelineReport.dataset_counts.clean_transitions}`);
    console.log(`SFT Demonstrations   : ${pipelineReport.dataset_counts.sft_demonstrations_samples}`);
    console.log(`Anomalies Found      : ${pipelineReport.anomalies.contradictory_labels_found} contradictory, ${pipelineReport.anomalies.missing_labels_found} missing`);
    console.log(`Metadata Corrections : ${pipelineReport.anomalies.metadata_corrections_applied}`);
    console.log(`Lessons Ingested     : ${pipelineReport.persistent_learning.lessonsLearned}`);
    console.log(`Training Eval Loss   : ${pipelineReport.training_metrics?.best_checkpoint?.best_eval_loss ?? 'N/A'}`);
    console.log(`Evaluation Decision  : ${isAccepted ? 'ACCEPTED' : 'REJECTED'}`);
    console.log(`Active Model Version : ${pipelineReport.model_deployment?.active_version ?? 'None'}`);
    if (pipelineReport.task_aware_prioritization) {
      console.log(`Archived Raw Data    : ${pipelineReport.task_aware_prioritization.archive_dir}`);
      console.log(`Condition Clusters   : ${pipelineReport.task_aware_prioritization.total_clusters}`);
      console.log(`Method Priorities    : Primary: ${pipelineReport.task_aware_prioritization.prioritized_breakdown.primary}, Fallback: ${pipelineReport.task_aware_prioritization.prioritized_breakdown.fallback}, Deprioritized: ${pipelineReport.task_aware_prioritization.prioritized_breakdown.deprioritized}`);
    }
    console.log(`Full Report Saved    : ${pipelineReportPath}`);
    console.log('================================================================\n');

    return pipelineReport;
  } catch (err) {
    console.error(`[Pipeline Error]`, err);
    pipelineReport.status = 'error';
    pipelineReport.errors.push(err.message);
    fs.writeFileSync(pipelineReportPath, JSON.stringify(pipelineReport, null, 2), 'utf-8');
    throw err;
  }
}

function roundNumber(num, dec = 2) {
  const factor = Math.pow(10, dec);
  return Math.round(num * factor) / factor;
}

// CLI Execution support
const isDirectCli = process.argv[1] && (
  process.argv[1].endsWith('index.js') ||
  process.argv[1].endsWith('pipeline')
);

if (isDirectCli) {
  const args = process.argv.slice(2);
  const options = {
    rollback: args.includes('--rollback'),
    forceTrain: args.includes('--force-train'),
    epochs: args.includes('--epochs') ? parseInt(args[args.indexOf('--epochs') + 1], 10) : 3,
    batchSize: args.includes('--batch-size') ? parseInt(args[args.indexOf('--batch-size') + 1], 10) : 8
  };
  runAutonomousPipeline(options).catch(() => process.exit(1));
}
