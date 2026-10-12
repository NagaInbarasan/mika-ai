/**
 * MIKA V1.3 - Persistent Task Manager
 * 
 * Implements an 8-state formal lifecycle state machine for survival tasks,
 * hierarchical interruption/resumption stack with verified checkpoints,
 * dependency tracking, and anti-stagnation thrashing protection.
 */

export const TASK_STATE = Object.freeze({
  PLANNED: 'PLANNED',
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  BLOCKED: 'BLOCKED',
  INTERRUPTED: 'INTERRUPTED',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

export const TASK_CATEGORY = Object.freeze({
  SURVIVAL: 'SURVIVAL',
  SHELTER: 'SHELTER',
  CRAFTING: 'CRAFTING',
  FOOD: 'FOOD',
  STORAGE: 'STORAGE',
  EXPLORATION: 'EXPLORATION'
});

// Valid transition mapping
const VALID_TRANSITIONS = {
  [TASK_STATE.PLANNED]: [TASK_STATE.READY, TASK_STATE.BLOCKED, TASK_STATE.FAILED],
  [TASK_STATE.READY]: [TASK_STATE.IN_PROGRESS, TASK_STATE.BLOCKED, TASK_STATE.FAILED],
  [TASK_STATE.IN_PROGRESS]: [TASK_STATE.INTERRUPTED, TASK_STATE.VERIFYING, TASK_STATE.BLOCKED, TASK_STATE.FAILED, TASK_STATE.COMPLETED],
  [TASK_STATE.INTERRUPTED]: [TASK_STATE.READY, TASK_STATE.IN_PROGRESS, TASK_STATE.BLOCKED, TASK_STATE.FAILED],
  [TASK_STATE.VERIFYING]: [TASK_STATE.COMPLETED, TASK_STATE.IN_PROGRESS, TASK_STATE.FAILED],
  [TASK_STATE.BLOCKED]: [TASK_STATE.READY, TASK_STATE.PLANNED, TASK_STATE.FAILED],
  [TASK_STATE.FAILED]: [TASK_STATE.READY, TASK_STATE.PLANNED], // allows retry/recovery
  [TASK_STATE.COMPLETED]: [TASK_STATE.READY] // allows reopening if invalidated
};

export class Task {
  constructor(def = {}) {
    if (!def.id) {
      throw new Error('Task definition must include a unique `id`');
    }
    this.id = def.id;
    this.objective = def.objective || def.id;
    this.category = def.category || TASK_CATEGORY.SURVIVAL;
    this.priorityTier = typeof def.priorityTier === 'number' ? def.priorityTier : 3;
    this.prerequisites = Array.isArray(def.prerequisites) ? [...def.prerequisites] : [];
    this.requiredResources = Array.isArray(def.requiredResources) ? [...def.requiredResources] : [];
    this.completionCondition = typeof def.completionCondition === 'function' ? def.completionCondition : null;
    
    this.state = def.state || TASK_STATE.PLANNED;
    this.progress = {
      current: def.progress?.current || 0,
      total: def.progress?.total || 1,
      unit: def.progress?.unit || 'steps',
      checkpoint: def.progress?.checkpoint || null
    };

    this.retryCount = def.retryCount || 0;
    this.maxRetries = typeof def.maxRetries === 'number' ? def.maxRetries : 3;
    this.failureReason = def.failureReason || null;
    this.recoveryStrategy = def.recoveryStrategy || null;
    this.interruptedState = def.interruptedState || null;

    this.createdTime = def.createdTime || Date.now();
    this.updatedTime = def.updatedTime || Date.now();
    this.history = [];
  }

  canTransitionTo(nextState) {
    const allowed = VALID_TRANSITIONS[this.state] || [];
    return allowed.includes(nextState);
  }

  transitionTo(nextState, meta = {}) {
    if (!this.canTransitionTo(nextState)) {
      throw new Error(`Invalid state transition: cannot transition task '${this.id}' from '${this.state}' to '${nextState}'`);
    }

    const prevState = this.state;
    this.state = nextState;
    this.updatedTime = Date.now();

    const entry = {
      from: prevState,
      to: nextState,
      timestamp: this.updatedTime,
      reason: meta.reason || '',
      checkpoint: meta.checkpoint || this.progress.checkpoint
    };
    this.history.push(entry);

    if (meta.reason) {
      if (nextState === TASK_STATE.FAILED || nextState === TASK_STATE.BLOCKED) {
        this.failureReason = meta.reason;
      }
    }

    if (meta.checkpoint !== undefined) {
      this.progress.checkpoint = meta.checkpoint;
    }

    if (meta.progress !== undefined) {
      if (typeof meta.progress.current === 'number') this.progress.current = meta.progress.current;
      if (typeof meta.progress.total === 'number') this.progress.total = meta.progress.total;
    }

    return entry;
  }

  updateCheckpoint(checkpoint, progressUpdate = null) {
    this.progress.checkpoint = checkpoint;
    if (progressUpdate) {
      if (typeof progressUpdate.current === 'number') this.progress.current = progressUpdate.current;
      if (typeof progressUpdate.total === 'number') this.progress.total = progressUpdate.total;
    }
    this.updatedTime = Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      objective: this.objective,
      category: this.category,
      priorityTier: this.priorityTier,
      prerequisites: this.prerequisites,
      requiredResources: this.requiredResources,
      state: this.state,
      progress: this.progress,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      failureReason: this.failureReason,
      recoveryStrategy: this.recoveryStrategy,
      interruptedState: this.interruptedState,
      createdTime: this.createdTime,
      updatedTime: this.updatedTime
    };
  }
}

export class TaskManager {
  constructor(options = {}) {
    this.tasks = new Map();
    this.activeTaskId = null;
    this.interruptStack = []; // Stack of { taskId, checkpoint, pausedAt, reason }
    this.completedTaskIds = new Set();
    
    // Anti-stagnation configuration
    this.thrashWindowMs = options.thrashWindowMs || 45000;
    this.maxRapidSwitches = options.maxRapidSwitches || 4;
    this.recentSwitches = [];
    this.stagnationDetected = false;
    this.stagnationCooldownUntil = 0;
  }

  /**
   * Registers a new task or updates an existing planned task.
   */
  register(taskOrDef) {
    const task = taskOrDef instanceof Task ? taskOrDef : new Task(taskOrDef);
    this.tasks.set(task.id, task);
    this.evaluatePrerequisites(task.id);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  getActiveTask() {
    if (!this.activeTaskId) return null;
    return this.tasks.get(this.activeTaskId) || null;
  }

  /**
   * Re-evaluates whether prerequisites of a task are fulfilled.
   */
  evaluatePrerequisites(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Completed or failed tasks are not changed by prereq check
    if (task.state === TASK_STATE.COMPLETED || task.state === TASK_STATE.FAILED) {
      return false;
    }

    if (task.prerequisites.length === 0) {
      if (task.state === TASK_STATE.PLANNED) {
        task.transitionTo(TASK_STATE.READY, { reason: 'No prerequisites required' });
      }
      return true;
    }

    const allPrereqsMet = task.prerequisites.every(prereqId => {
      const prereq = this.tasks.get(prereqId);
      return prereq && prereq.state === TASK_STATE.COMPLETED;
    });

    const anyPrereqBlocked = task.prerequisites.some(prereqId => {
      const prereq = this.tasks.get(prereqId);
      return prereq && (prereq.state === TASK_STATE.BLOCKED || prereq.state === TASK_STATE.FAILED);
    });

    if (anyPrereqBlocked && task.state !== TASK_STATE.BLOCKED) {
      task.transitionTo(TASK_STATE.BLOCKED, { reason: 'One or more prerequisites are blocked or failed' });
      return false;
    }

    if (allPrereqsMet) {
      if (task.state === TASK_STATE.PLANNED || task.state === TASK_STATE.BLOCKED) {
        task.transitionTo(TASK_STATE.READY, { reason: 'All prerequisites fulfilled' });
      }
      return true;
    }

    return false;
  }

  /**
   * Activates a task to IN_PROGRESS.
   */
  startTask(taskId, meta = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    if (task.state === TASK_STATE.PLANNED) {
      this.evaluatePrerequisites(taskId);
    }

    if (task.state !== TASK_STATE.READY && task.state !== TASK_STATE.INTERRUPTED) {
      throw new Error(`Cannot start task '${taskId}' in state '${task.state}'; must be READY or INTERRUPTED`);
    }

    // Check anti-stagnation thrashing
    this._recordTaskSwitch(taskId);

    if (this.activeTaskId && this.activeTaskId !== taskId) {
      const prevTask = this.tasks.get(this.activeTaskId);
      if (prevTask && prevTask.state === TASK_STATE.IN_PROGRESS) {
        // Automatically interrupt previous task if preempted by a different task
        this.interruptCurrentTask('Preempted by task switch', prevTask.progress.checkpoint);
      }
    }

    task.transitionTo(TASK_STATE.IN_PROGRESS, meta);
    this.activeTaskId = taskId;
    return task;
  }

  /**
   * Emergency Preemption / Interruption:
   * Pauses the active task, preserves its checkpoint, and pushes it onto the interrupt stack.
   */
  interruptCurrentTask(reason = 'Emergency threat preemption', checkpoint = null) {
    if (!this.activeTaskId) return null;

    const task = this.tasks.get(this.activeTaskId);
    if (!task || task.state !== TASK_STATE.IN_PROGRESS) {
      this.activeTaskId = null;
      return null;
    }

    const savedCheckpoint = checkpoint !== null ? checkpoint : task.progress.checkpoint;
    task.interruptedState = {
      pausedAt: Date.now(),
      reason,
      checkpoint: savedCheckpoint,
      tier: task.priorityTier
    };

    task.transitionTo(TASK_STATE.INTERRUPTED, {
      reason,
      checkpoint: savedCheckpoint
    });

    this.interruptStack.push({
      taskId: task.id,
      checkpoint: savedCheckpoint,
      pausedAt: Date.now(),
      reason
    });

    console.log(`[TaskManager] Task '${task.id}' INTERRUPTED: "${reason}" (Checkpoint preserved)`);
    this.activeTaskId = null;
    return task;
  }

  /**
   * Checks if there are interrupted tasks waiting on the stack.
   */
  hasInterruptedTasks() {
    return this.interruptStack.length > 0;
  }

  /**
   * Resumes the most recently interrupted task from its verified checkpoint.
   */
  resumeInterruptedTask(meta = {}) {
    if (this.interruptStack.length === 0) return null;

    const topEntry = this.interruptStack.pop();
    const task = this.tasks.get(topEntry.taskId);
    if (!task) return null;

    if (task.state !== TASK_STATE.INTERRUPTED) {
      console.warn(`[TaskManager] Interrupted task '${task.id}' is in unexpected state '${task.state}'; skipping resumption`);
      return null;
    }

    console.log(`[TaskManager] Resuming task '${task.id}' from checkpoint:`, topEntry.checkpoint);
    task.interruptedState = null;
    task.transitionTo(TASK_STATE.IN_PROGRESS, {
      reason: meta.reason || `Resumed after threat cleared: ${topEntry.reason}`,
      checkpoint: topEntry.checkpoint
    });

    this.activeTaskId = task.id;
    return task;
  }

  /**
   * Marks a task as VERIFYING and performs world verification check.
   */
  verifyAndComplete(taskId, worldVerificationFn, meta = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    if (task.state === TASK_STATE.IN_PROGRESS) {
      task.transitionTo(TASK_STATE.VERIFYING, { reason: 'Verifying completion condition in world' });
    }

    let verification = { verified: true, reason: 'Manual completion' };
    if (typeof worldVerificationFn === 'function') {
      try {
        verification = worldVerificationFn();
      } catch (err) {
        verification = { verified: false, reason: `Verification error: ${err.message}` };
      }
    } else if (task.completionCondition) {
      try {
        const cond = task.completionCondition(meta.worldState);
        verification = { verified: cond.completed, reason: cond.reason };
      } catch (err) {
        verification = { verified: false, reason: `Condition check error: ${err.message}` };
      }
    }

    if (verification.verified) {
      task.progress.current = task.progress.total;
      task.transitionTo(TASK_STATE.COMPLETED, {
        reason: verification.reason || 'Verified complete by physical world state'
      });
      this.completedTaskIds.add(taskId);
      if (this.activeTaskId === taskId) {
        this.activeTaskId = null;
      }

      // Propagate completion to unblock dependent tasks
      for (const t of this.tasks.values()) {
        if (t.prerequisites.includes(taskId)) {
          this.evaluatePrerequisites(t.id);
        }
      }
      return { success: true, task, reason: verification.reason };
    } else {
      task.retryCount += 1;
      if (task.retryCount >= task.maxRetries) {
        task.transitionTo(TASK_STATE.FAILED, {
          reason: `Verification failed after ${task.retryCount} attempts: ${verification.reason}`
        });
        if (this.activeTaskId === taskId) {
          this.activeTaskId = null;
        }
        return { success: false, task, failed: true, reason: verification.reason };
      } else {
        // Return to IN_PROGRESS to retry
        task.transitionTo(TASK_STATE.IN_PROGRESS, {
          reason: `Verification failed: ${verification.reason}; retrying (${task.retryCount}/${task.maxRetries})`
        });
        return { success: false, task, retrying: true, reason: verification.reason };
      }
    }
  }

  /**
   * Explicitly marks a task as BLOCKED.
   */
  markBlocked(taskId, reason) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (task.state !== TASK_STATE.BLOCKED) {
      task.transitionTo(TASK_STATE.BLOCKED, { reason });
    }
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
    }
    return task;
  }

  /**
   * Anti-stagnation thrashing detector.
   * Tracks oscillation frequency and triggers tactical backoff when cycling without progress.
   */
  _recordTaskSwitch(taskId) {
    const now = Date.now();
    this.recentSwitches = this.recentSwitches.filter(s => now - s.timestamp <= this.thrashWindowMs);
    this.recentSwitches.push({ taskId, timestamp: now });

    // Count how many times we switched back and forth recently
    if (this.recentSwitches.length >= this.maxRapidSwitches) {
      const distinctTasks = new Set(this.recentSwitches.map(s => s.taskId));
      // If we switched 4+ times between only 2 or 3 distinct tasks without completions
      if (distinctTasks.size <= 2) {
        this.stagnationDetected = true;
        this.stagnationCooldownUntil = now + 15000; // 15s tactical backoff cooldown
        console.warn(`[TaskManager] Anti-stagnation trigger! Detected task thrashing between [${Array.from(distinctTasks).join(', ')}] without progress. Enforcing 15s backoff.`);
      }
    }
  }

  isStagnationActive() {
    if (!this.stagnationDetected) return false;
    if (Date.now() >= this.stagnationCooldownUntil) {
      this.stagnationDetected = false;
      this.recentSwitches = [];
      return false;
    }
    return true;
  }

  /**
   * Finds the highest-priority READY task to execute next.
   */
  getNextExecutableTask() {
    // If an interrupted task is waiting, it takes top priority once threats clear!
    if (this.hasInterruptedTasks()) {
      const top = this.interruptStack[this.interruptStack.length - 1];
      const task = this.tasks.get(top.taskId);
      if (task && task.state === TASK_STATE.INTERRUPTED) {
        return task;
      }
    }

    const readyTasks = Array.from(this.tasks.values())
      .filter(t => t.state === TASK_STATE.READY)
      .sort((a, b) => a.priorityTier - b.priorityTier);

    return readyTasks[0] || null;
  }
}
