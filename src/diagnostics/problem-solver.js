import fs from 'fs';
import path from 'path';
import config from '../config/index.js';
import { defaultProblemDetector, PROBLEM_TYPES } from './problem-detector.js';
import { defaultProblemDiagnostician, ROOT_CAUSE_CATEGORIES } from './problem-diagnostician.js';
import { defaultResolutionPlanner } from './resolution-planner.js';
import { defaultRecoveryExecutor } from './recovery-executor.js';
import defaultMemoryStore from '../learning/memory.js';

/**
 * MIKA V1.3 — General Problem Identification, Diagnosis and Resolution System
 * 
 * Reusable, end-to-end autonomous problem solver across all Minecraft activities:
 * movement, navigation, resource gathering, crafting, shelter construction,
 * storage, food management, combat, survival, and learned skills.
 * 
 * Continuous Pipeline:
 * 1. Detect Problems: World state vs expected outcome comparison
 * 2. Identify & Diagnose: Evidence gathering and root cause classification
 * 3. Plan Resolution: Ranked candidate solutions with cost and confidence
 * 4. Execute Recovery: Safe execution, empirical verification, multi-plan escalation
 * 5. Learn & Persist: Stores lessons and diagnostic history in persistent memory
 */

export class ProblemSolver {
  constructor(options = {}) {
    this.detector = options.detector || defaultProblemDetector;
    this.diagnostician = options.diagnostician || defaultProblemDiagnostician;
    this.planner = options.planner || defaultResolutionPlanner;
    this.executor = options.executor || defaultRecoveryExecutor;
    this.memoryStore = options.memoryStore || defaultMemoryStore;
    this.diagnosticsLogPath = options.diagnosticsLogPath || path.join(config.storage.dataDir, 'diagnostics.json');

    this.stats = {
      problemsDetected: 0,
      problemsResolved: 0,
      escalatedCount: 0,
      byCategory: {}
    };

    this.log = [];
    this.loadLog();
  }

  loadLog() {
    try {
      if (fs.existsSync(this.diagnosticsLogPath)) {
        const raw = fs.readFileSync(this.diagnosticsLogPath, 'utf-8');
        this.log = JSON.parse(raw);
        for (const item of this.log) {
          this.stats.problemsDetected += 1;
          if (item.resolved) this.stats.problemsResolved += 1;
          const cat = item.diagnosis?.category || 'UNKNOWN';
          this.stats.byCategory[cat] = (this.stats.byCategory[cat] || 0) + 1;
        }
      }
    } catch (_) {}
  }

  saveLog() {
    try {
      fs.mkdirSync(path.dirname(this.diagnosticsLogPath), { recursive: true });
      fs.writeFileSync(this.diagnosticsLogPath, JSON.stringify(this.log.slice(-100), null, 2), 'utf-8');
    } catch (_) {}
  }

  /**
   * Main entry point: Inspects an action or state event, diagnoses any failure,
   * executes verified recovery, and updates persistent memory.
   * 
   * @param {Object} params
   * @returns {Promise<Object>} Diagnostic and recovery outcome
   */
  async handleProblem(params = {}) {
    const { bot, action, args, execution, outcome, preObservation, postObservation, currentGoal } = params;

    // 1. Detect Problem
    const problem = this.detector.detectProblem({
      bot,
      action,
      args,
      execution,
      outcome,
      preObservation,
      postObservation,
      currentGoal
    });

    if (!problem.hasProblem) {
      return { hasProblem: false, resolved: true, message: 'Nominal operation' };
    }

    this.stats.problemsDetected += 1;
    console.warn(`\n[ProblemSolver] Problem Detected: [${problem.problemType}] (Severity: ${problem.severity})`);
    console.warn(`[ProblemSolver] Evidence: ${problem.evidence}`);

    // 2. Identify and Diagnose Root Cause
    const diagnosis = this.diagnostician.diagnose({
      problem,
      bot,
      worldState: postObservation || preObservation,
      currentTask: currentGoal
    });

    const cat = diagnosis.category || 'UNKNOWN';
    this.stats.byCategory[cat] = (this.stats.byCategory[cat] || 0) + 1;
    console.log(`[ProblemSolver] Root Cause Identified: [${diagnosis.category}] "${diagnosis.rootCause}" (Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%)`);

    // 3. Plan Resolution Strategies
    const plans = this.planner.generateResolutionPlans({
      diagnosis,
      bot,
      worldState: postObservation || preObservation
    });

    console.log(`[ProblemSolver] Generated ${plans.length} candidate recovery plans. Top plan: [${plans[0]?.action}] "${plans[0]?.strategy}"`);

    // 4. Execute Recovery Actions & Verify Outcomes
    const recoveryResult = await this.executor.executeRecovery({
      bot,
      resolutionPlans: plans,
      diagnosis,
      originalTask: currentGoal
    });

    if (recoveryResult.recovered) {
      this.stats.problemsResolved += 1;
      this.detector.resetStagnation(`${currentGoal}:${action}`);
    } else {
      this.stats.escalatedCount += 1;
    }

    // 5. Learn from Experience & Persist to Memory
    const logEntry = {
      id: `diag-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      problemType: problem.problemType,
      severity: problem.severity,
      diagnosis,
      plansCount: plans.length,
      successfulPlan: recoveryResult.successfulPlan || null,
      resolved: recoveryResult.recovered,
      escalated: recoveryResult.escalated || false,
      durationMs: recoveryResult.durationMs || 0
    };

    this.log.push(logEntry);
    this.saveLog();

    // Store in PersistentMemoryStore
    if (this.memoryStore && typeof this.memoryStore.storeSurvivalLesson === 'function') {
      try {
        this.memoryStore.storeSurvivalLesson({
          goalId: currentGoal || 'general_recovery',
          situationPattern: `${problem.problemType}:${diagnosis.category}`,
          failureCategory: diagnosis.category,
          evidence: problem.evidence,
          correction: recoveryResult.successfulPlan ? { action: recoveryResult.successfulPlan.action, args: recoveryResult.successfulPlan.args } : null,
          wasSuccessful: recoveryResult.recovered
        });
      } catch (_) {}
    }

    return {
      hasProblem: true,
      problem,
      diagnosis,
      plans,
      recoveryResult,
      resolved: recoveryResult.recovered,
      logEntry
    };
  }

  getSummary() {
    const rate = this.stats.problemsDetected > 0
      ? Math.round((this.stats.problemsResolved / this.stats.problemsDetected) * 100)
      : 100;
    return {
      problemsDetected: this.stats.problemsDetected,
      problemsResolved: this.stats.problemsResolved,
      escalatedCount: this.stats.escalatedCount,
      resolutionRate: `${rate}%`,
      byCategory: this.stats.byCategory
    };
  }
}

export const defaultProblemSolver = new ProblemSolver();
export default defaultProblemSolver;
