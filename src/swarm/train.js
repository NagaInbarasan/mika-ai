/**
 * Swarm Automated Training Runner.
 * Coordinates accelerated multi-bot training (up to 4 bots) operating concurrently
 * without LLM inference bottlenecks (deterministic heuristic & collaborative rules).
 * Logs multi-agent trajectories and automatically triggers offline preprocessing.
 */

import fs from 'fs';
import path from 'path';
import config from '../config/index.js';
import { SwarmOrchestrator } from './orchestrator.js';
import { runPreprocessing } from '../data/preprocess.js';

export function parseTrainingArgs() {
  const args = process.argv.slice(2);
  const options = {
    bots: 4,
    episodes: 5,
    steps: 15,
    port: config.minecraft.port,
    host: config.minecraft.host,
    preprocess: true,
    skipLlm: true
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bots' && args[i + 1]) {
      options.bots = Math.max(1, Math.min(6, parseInt(args[i + 1], 10)));
      i++;
    } else if (args[i] === '--episodes' && args[i + 1]) {
      options.episodes = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--steps' && args[i + 1]) {
      options.steps = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === '--no-preprocess') {
      options.preprocess = false;
    } else if (args[i] === '--skip-llm' || args[i] === '--no-qwen') {
      options.skipLlm = true;
    }
  }

  return options;
}

export class SwarmTrainingRunner {
  constructor(options = {}) {
    this.options = {
      bots: options.bots || 4,
      episodes: options.episodes || 5,
      steps: options.steps || 15,
      port: options.port !== undefined ? options.port : config.minecraft.port,
      host: options.host || config.minecraft.host,
      preprocess: options.preprocess !== undefined ? options.preprocess : true,
      skipLlm: true,
      ...options
    };

    this.reportsDir = path.join(config.storage.dataDir, 'reports');
    this.reportPath = path.join(this.reportsDir, 'swarm_training_report.json');
    fs.mkdirSync(this.reportsDir, { recursive: true });
  }

  /**
   * Executes the automated multi-bot training pipeline.
   * @param {SwarmOrchestrator} [mockOrchestrator=null] - Optional for unit testing
   * @returns {Promise<Object>}
   */
  async runTraining(mockOrchestrator = null) {
    const startTime = Date.now();
    console.log('====================================================');
    console.log('   MIKA AUTOMATED MULTI-BOT SWARM TRAINING SYSTEM   ');
    console.log('====================================================');
    console.log(`Parallel Bots   : ${this.options.bots} (Max: 4 bots)`);
    console.log(`Total Episodes  : ${this.options.episodes}`);
    console.log(`Step Budget     : ${this.options.steps} steps / episode`);
    console.log(`Target Host     : ${this.options.host}:${this.options.port}`);
    console.log(`Planning Engine : Fast Collaborative Heuristic (Qwen Skipped)`);
    console.log(`Auto Preprocess : ${this.options.preprocess ? 'Enabled' : 'Disabled'}`);
    console.log('====================================================\n');

    const orchestrator = mockOrchestrator || new SwarmOrchestrator({
      botCount: this.options.bots,
      host: this.options.host,
      port: this.options.port,
      staggerMs: 1200,
      stepIntervalMs: 1500
    });

    const trainingMetrics = {
      session_id: `swarm-train-${Date.now()}`,
      bots_count: this.options.bots,
      total_episodes: this.options.episodes,
      steps_per_episode: this.options.steps,
      completed_episodes: 0,
      total_bot_steps: 0,
      start_time: new Date().toISOString(),
      end_time: null,
      duration_ms: 0,
      swarm_stats: {}
    };

    try {
      if (!mockOrchestrator) {
        await orchestrator.spawnSwarm({
          botCount: this.options.bots,
          host: this.options.host,
          port: this.options.port
        });

        const allSpawned = await orchestrator.waitForAllSpawns(30000);
        if (!allSpawned) {
          console.warn('[Swarm Training] Warning: Some bots did not complete spawn within timeout.');
        }
      }

      // Execute Episodes
      for (let ep = 1; ep <= this.options.episodes; ep++) {
        console.log(`\n====================================================`);
        console.log(` [Training Episode #${ep}/${this.options.episodes}] (Swarm: ${this.options.bots} bots)`);
        console.log(`====================================================`);

        await orchestrator.runCooperativeSurvival(this.options.steps);
        trainingMetrics.completed_episodes += 1;
        trainingMetrics.total_bot_steps += (this.options.steps * this.options.bots);
      }

      const summary = orchestrator.blackboard.getSummary();
      trainingMetrics.swarm_stats = summary.stats;
    } catch (err) {
      console.error('[Swarm Training] Error during training session:', err.message);
    } finally {
      if (!mockOrchestrator) {
        orchestrator.stopAll('Training completed');
      }
    }

    const duration = Date.now() - startTime;
    trainingMetrics.end_time = new Date().toISOString();
    trainingMetrics.duration_ms = duration;

    // Save Training Report
    try {
      fs.writeFileSync(this.reportPath, JSON.stringify(trainingMetrics, null, 2), 'utf-8');
      console.log(`\n[Swarm Training] Session report saved to: ${this.reportPath}`);
    } catch (saveErr) {
      console.error('[Swarm Training] Failed to write training report:', saveErr.message);
    }

    // Step 2: Automatically run preprocessing pipeline if enabled
    if (this.options.preprocess) {
      console.log('\n[Swarm Training] Executing offline preprocessing pipeline on newly gathered data...');
      try {
        const prepReport = await runPreprocessing({
          experiencesPath: config.storage.experiencesPath,
          feedbackPath: config.storage.feedbackPath,
          outputDir: path.join(config.storage.dataDir, 'processed'),
          reportDir: path.join(config.storage.dataDir, 'reports')
        });
        console.log(`[Swarm Training] Preprocessing finished: Generated ${prepReport.datasets.sft_chatml_train} SFT examples & ${prepReport.datasets.dpo_pairs} DPO pairs!`);
      } catch (prepErr) {
        console.warn(`[Swarm Training] Preprocessing warning: ${prepErr.message}`);
      }
    }

    console.log(`\n[Swarm Training Complete] Successfully trained ${this.options.bots} bots over ${this.options.episodes} episodes in ${Math.round(duration / 1000)}s!`);
    return trainingMetrics;
  }
}

// CLI Execution entry point if run directly
if (process.argv[1] && process.argv[1].endsWith('train.js')) {
  const opts = parseTrainingArgs();
  const runner = new SwarmTrainingRunner(opts);

  // Graceful shutdown handling
  process.on('SIGINT', () => {
    console.log('\n[Swarm Training] Interrupted by user. Shutting down cleanly...');
    process.exit(0);
  });

  runner.runTraining().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error('[Fatal Error]', err);
    process.exit(1);
  });
}

export default SwarmTrainingRunner;
