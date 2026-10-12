import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';

export class ExperienceRecorder {
  constructor(options = {}) {
    this.runId = options.runId || `run-${Date.now()}`;
    this.episodeId = options.episodeId || `episode-1`;
    this.step = 0;
    this.experiencesPath = options.experiencesPath || config.storage.experiencesPath;
    this.feedbackPath = options.feedbackPath || config.storage.feedbackPath;

    // Ensure output directories exist
    fs.mkdirSync(path.dirname(this.experiencesPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.feedbackPath), { recursive: true });
  }

  /**
   * Appends an experience record to experiences.jsonl.
   * @param {Object} recordData
   * @returns {Object} Complete recorded event
   */
  recordExperience(recordData) {
    this.step += 1;
    const event = {
      schema_version: '1.0',
      event_id: uuidv4(),
      run_id: this.runId,
      episode_id: this.episodeId,
      step: this.step,
      timestamp: new Date().toISOString(),
      environment: {
        minecraft_version: recordData.minecraft_version || '1.21',
        dimension: recordData.dimension || 'overworld',
        world_id: recordData.world_id || 'local'
      },
      observation_before: recordData.observation_before || null,
      goal: recordData.goal || 'survive and observe',
      available_actions: recordData.available_actions || [],
      decision: recordData.decision || (recordData.action ? {
        action: recordData.action,
        arguments: recordData.arguments || recordData.args || {},
        goal: recordData.goal || 'survive and progress',
        reason_summary: recordData.reason_summary || '',
        expected_outcome: recordData.expected_outcome || ''
      } : null),
      execution: recordData.execution || (recordData.result?.status ? {
        status: recordData.result.status === 'SUCCESS' ? 'success' : (recordData.result.status === 'FAILED' ? 'failed' : 'partial'),
        duration_ms: recordData.duration_ms || 0,
        error: recordData.result.failureReason || null,
        error_code: recordData.result.failureCategory || null
      } : { status: 'observed', duration_ms: 0, error_code: null }),
      observation_after: recordData.observation_after || null,
      outcome: recordData.outcome || (recordData.result ? {
        task_progress: recordData.result.goalAchieved ? 1.0 : 0.0,
        reward: recordData.result.deltas?.reward ?? (recordData.result.goalAchieved ? 1.0 : -0.5),
        health_delta: recordData.result.deltas?.healthDelta ?? 0,
        damage_taken: recordData.result.deltas?.damageTaken ?? 0,
        food_delta: recordData.result.deltas?.foodDelta ?? 0,
        resource_delta: recordData.result.deltas?.resourceDelta || {},
        predicted_outcome_met: recordData.result.goalAchieved
      } : { task_progress: 0, reward: 0 }),
      learning: recordData.learning || (recordData.result ? {
        failure_detected: !recordData.result.goalAchieved,
        failure_category: recordData.result.failureCategory || null,
        feedback_event_ids: [],
        correction_applied: false,
        correction_verified: null
      } : {
        failure_detected: false,
        failure_category: null,
        feedback_event_ids: [],
        correction_applied: false,
        correction_verified: null
      }),
      model: {
        provider: 'ollama',
        model_id: config.ollama.model,
        prompt_version: '1.0'
      }
    };

    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(this.experiencesPath, line, 'utf-8');
    return event;
  }

  /**
   * Appends a feedback or correction record to feedback.jsonl.
   * @param {Object} feedbackData 
   * @returns {Object}
   */
  recordFeedback(feedbackData) {
    const event = {
      schema_version: '1.0',
      event_id: uuidv4(),
      event_type: feedbackData.event_type || 'user_feedback',
      run_id: this.runId,
      episode_id: this.episodeId,
      step: this.step,
      timestamp: new Date().toISOString(),
      related_event_id: feedbackData.related_event_id || null,
      label: feedbackData.label || null,
      feedback_text: feedbackData.feedback_text || '',
      correction_proposed: feedbackData.correction_proposed || null,
      applied: feedbackData.applied || false
    };

    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(this.feedbackPath, line, 'utf-8');
    return event;
  }
}

export default ExperienceRecorder;
