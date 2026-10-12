import fs from 'fs';
import path from 'path';

/**
 * MIKA Visual Experience & Evaluation Logger
 * Records derived visual features, chosen targets, actions, and outcomes for training.
 * Evaluates detection accuracy and task success separately.
 */
export class VisualExperienceLogger {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data', 'vision');
    this.experiencesPath = path.join(this.dataDir, 'experiences.jsonl');
    this.reportPath = path.join(process.cwd(), 'data', 'reports', 'vision_report.json');

    this.stats = {
      total_frames: 0,
      total_detections: 0,
      true_positives: 0,
      false_positives: 0,
      missed_targets: 0,
      latencies: [],
      vrams: [],
      tasks_attempted: 0,
      tasks_succeeded: 0,
      total_wood_harvested: 0,
      task_durations: []
    };

    if (!fs.existsSync(this.dataDir)) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
      } catch (_) {}
    }
  }

  /**
   * Logs a single visual targeting episode step.
   * @param {Object} entry
   */
  logExperience(entry) {
    const record = {
      timestamp: entry.timestamp || new Date().toISOString(),
      frame_id: entry.frame_id || `frame-${Date.now()}`,
      camera: entry.camera || {},
      detections_count: entry.detections?.length || 0,
      detections_summary: (entry.detections || []).map(d => ({
        class: d.class,
        confidence: d.confidence,
        bbox: d.bbox,
        center: d.center
      })),
      chosen_target: entry.chosen_target ? {
        id: entry.chosen_target.id,
        class: entry.chosen_target.class,
        confidence: entry.chosen_target.confidence,
        worldPos: entry.chosen_target.worldPos,
        distance: entry.chosen_target.distance,
        score: entry.chosen_target.score
      } : null,
      action: entry.action || 'harvest_tree_trunk',
      outcome: entry.outcome || {},
      accuracy: entry.accuracy || {},
      inference_latency_ms: entry.latency_ms || 0,
      gpu_vram_mb: entry.gpu_vram_mb || 0
    };

    // Update cumulative stats
    this.stats.total_frames++;
    this.stats.total_detections += record.detections_count;
    if (entry.accuracy?.stepTruePositives) this.stats.true_positives += entry.accuracy.stepTruePositives;
    if (entry.accuracy?.stepFalsePositives) this.stats.false_positives += entry.accuracy.stepFalsePositives;
    if (entry.accuracy?.stepMissedTargets) this.stats.missed_targets += entry.accuracy.stepMissedTargets;
    if (entry.latency_ms) this.stats.latencies.push(entry.latency_ms);
    if (entry.gpu_vram_mb) this.stats.vrams.push(entry.gpu_vram_mb);

    if (entry.actionAttempted) {
      this.stats.tasks_attempted++;
      if (entry.outcome?.success) {
        this.stats.tasks_succeeded++;
        this.stats.total_wood_harvested += (entry.outcome.delta || 1);
      }
      if (entry.outcome?.durationMs) {
        this.stats.task_durations.push(entry.outcome.durationMs);
      }
    }

    try {
      fs.appendFileSync(this.experiencesPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[VisionLogger] Failed to write experience log:', err.message);
    }

    return record;
  }

  /**
   * Generates and writes the comprehensive vision evaluation report.
   */
  generateReport() {
    const avgLatency = this.stats.latencies.length > 0
      ? this.stats.latencies.reduce((a, b) => a + b, 0) / this.stats.latencies.length
      : 0;

    const avgVram = this.stats.vrams.length > 0
      ? this.stats.vrams.reduce((a, b) => a + b, 0) / this.stats.vrams.length
      : 0;

    const avgDuration = this.stats.task_durations.length > 0
      ? this.stats.task_durations.reduce((a, b) => a + b, 0) / this.stats.task_durations.length
      : 0;

    const precisionDenominator = this.stats.true_positives + this.stats.false_positives;
    const precision = precisionDenominator > 0 ? this.stats.true_positives / precisionDenominator : 1.0;

    const recallDenominator = this.stats.true_positives + this.stats.missed_targets;
    const recall = recallDenominator > 0 ? this.stats.true_positives / recallDenominator : 1.0;

    const taskSuccessRate = this.stats.tasks_attempted > 0
      ? this.stats.tasks_succeeded / this.stats.tasks_attempted
      : 1.0;

    const report = {
      timestamp: new Date().toISOString(),
      vision_version: 'V1.3',
      dataset_size: this.stats.total_frames,
      detection_accuracy: {
        total_detections: this.stats.total_detections,
        true_positives: this.stats.true_positives,
        false_positives: this.stats.false_positives,
        missed_targets: this.stats.missed_targets,
        precision: Math.round(precision * 1000) / 1000,
        recall: Math.round(recall * 1000) / 1000,
        false_positive_rate: precisionDenominator > 0 ? Math.round((this.stats.false_positives / precisionDenominator) * 1000) / 1000 : 0.0
      },
      task_performance: {
        tasks_attempted: this.stats.tasks_attempted,
        tasks_succeeded: this.stats.tasks_succeeded,
        task_success_rate: Math.round(taskSuccessRate * 1000) / 1000,
        total_wood_harvested: this.stats.total_wood_harvested,
        avg_task_duration_ms: Math.round(avgDuration * 10) / 10
      },
      resource_metrics: {
        avg_inference_latency_ms: Math.round(avgLatency * 10) / 10,
        avg_gpu_vram_mb: Math.round(avgVram * 10) / 10
      }
    };

    try {
      const reportsDir = path.dirname(this.reportPath);
      if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(this.reportPath, JSON.stringify(report, null, 2), 'utf-8');
    } catch (_) {}

    return report;
  }
}

export default VisualExperienceLogger;
