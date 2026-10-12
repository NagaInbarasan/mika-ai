import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';

export class PersistentMemoryStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(config.storage.dataDir, 'memory.json');
    this.lessonsFilePath = options.lessonsFilePath || path.join(config.storage.dataDir, 'lessons.json');
    this.strategiesFilePath = options.strategiesFilePath || path.join(config.storage.dataDir, 'strategies.json');
    this.locationsFilePath = options.locationsFilePath || path.join(config.storage.dataDir, 'locations.json');
    this.deathsFilePath = options.deathsFilePath || path.join(config.storage.dataDir, 'deaths.json');
    this.memories = [];
    this.lessons = [];
    this.strategies = [];
    this.locations = [];
    this.deathHistory = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.memories = JSON.parse(data);
      } else {
        this.memories = [];
      }
    } catch (err) {
      console.warn(`[Memory] Error loading memory store from ${this.filePath}:`, err.message);
      this.memories = [];
    }

    try {
      if (fs.existsSync(this.lessonsFilePath)) {
        const lessonData = fs.readFileSync(this.lessonsFilePath, 'utf-8');
        this.lessons = JSON.parse(lessonData);
      } else {
        this.lessons = [];
      }
    } catch (err) {
      console.warn(`[Memory] Error loading lessons from ${this.lessonsFilePath}:`, err.message);
      this.lessons = [];
    }

    try {
      if (fs.existsSync(this.strategiesFilePath)) {
        const strategyData = fs.readFileSync(this.strategiesFilePath, 'utf-8');
        this.strategies = JSON.parse(strategyData);
      } else {
        this.strategies = [];
      }
    } catch (err) {
      console.warn(`[Memory] Error loading strategies from ${this.strategiesFilePath}:`, err.message);
      this.strategies = [];
    }

    try {
      if (fs.existsSync(this.locationsFilePath)) {
        const locData = fs.readFileSync(this.locationsFilePath, 'utf-8');
        this.locations = JSON.parse(locData);
      } else {
        this.locations = [];
      }
    } catch (err) {
      console.warn(`[Memory] Error loading locations from ${this.locationsFilePath}:`, err.message);
      this.locations = [];
    }

    try {
      if (fs.existsSync(this.deathsFilePath)) {
        const deathData = fs.readFileSync(this.deathsFilePath, 'utf-8');
        this.deathHistory = JSON.parse(deathData);
      } else {
        this.deathHistory = [];
      }
    } catch (err) {
      console.warn(`[Memory] Error loading deaths from ${this.deathsFilePath}:`, err.message);
      this.deathHistory = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.memories, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Memory] Error saving memory store:`, err.message);
    }

    try {
      fs.mkdirSync(path.dirname(this.lessonsFilePath), { recursive: true });
      fs.writeFileSync(this.lessonsFilePath, JSON.stringify(this.lessons, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Memory] Error saving lessons:`, err.message);
    }

    try {
      fs.mkdirSync(path.dirname(this.strategiesFilePath), { recursive: true });
      fs.writeFileSync(this.strategiesFilePath, JSON.stringify(this.strategies, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Memory] Error saving strategies:`, err.message);
    }

    try {
      fs.mkdirSync(path.dirname(this.locationsFilePath), { recursive: true });
      fs.writeFileSync(this.locationsFilePath, JSON.stringify(this.locations, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Memory] Error saving locations:`, err.message);
    }

    try {
      fs.mkdirSync(path.dirname(this.deathsFilePath), { recursive: true });
      fs.writeFileSync(this.deathsFilePath, JSON.stringify(this.deathHistory, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Memory] Error saving deaths:`, err.message);
    }
  }

  /**
   * Records or updates a learned correction in persistent memory.
   * @param {Object} params
   * @returns {Object} Updated memory entry
   */
  addOrUpdateCorrection({ situationPattern, failureCategory, evidence, correction, wasSuccessful = true }) {
    let entry = this.memories.find(m => m.situation_pattern === situationPattern);

    if (entry) {
      if (wasSuccessful) {
        entry.success_count += 1;
        entry.confidence = Math.min(1.0, Math.round((entry.confidence + 0.15) * 100) / 100);
        entry.status = 'active';
      } else {
        entry.failure_count += 1;
        entry.confidence = Math.max(0.0, Math.round((entry.confidence - 0.25) * 100) / 100);
        if (entry.confidence < 0.35) {
          entry.status = 'downgraded';
        }
      }
      entry.last_used_at = new Date().toISOString();
      entry.evidence = evidence || entry.evidence;
      if (wasSuccessful && correction) {
        entry.validated_correction = correction;
      }
    } else {
      entry = {
        id: uuidv4(),
        situation_pattern: situationPattern,
        previous_failure: failureCategory,
        evidence: evidence || 'Observed failure',
        validated_correction: correction,
        success_count: wasSuccessful ? 1 : 0,
        failure_count: wasSuccessful ? 0 : 1,
        confidence: wasSuccessful ? 0.75 : 0.25,
        status: wasSuccessful ? 'active' : 'downgraded',
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString()
      };
      this.memories.push(entry);
    }

    this.save();
    return entry;
  }

  /**
   * Stores a derived survival lesson separately from raw immutable experiences.
   * Prevents duplicate lessons and reconciles contradictory evidence.
   * Integrates human feedback to boost or temper confidence.
   *
   * @param {Object} params
   * @param {string} params.goalId
   * @param {string} params.situationPattern
   * @param {string} params.failureCategory
   * @param {string} params.evidence
   * @param {string|Object} params.correction
   * @param {boolean} [params.wasSuccessful=true]
   * @param {Object} [params.feedback=null] - { type: 'good'|'bad', message: string }
   * @returns {Object} Lesson entry
   */
  storeSurvivalLesson({
    goalId,
    situationPattern,
    failureCategory,
    evidence,
    correction,
    wasSuccessful = true,
    feedback = null
  }) {
    const key = `${goalId || 'general'}:${situationPattern || failureCategory}`;
    let lesson = this.lessons.find(l => l.pattern_key === key);

    // Baseline confidence calculation
    let feedbackDelta = 0;
    if (feedback) {
      if (feedback.type === 'good' || feedback.rating > 0) feedbackDelta = +0.2;
      else if (feedback.type === 'bad' || feedback.rating < 0) feedbackDelta = -0.25;
    }

    if (lesson) {
      // Reconcile contradiction or confirm knowledge
      if (wasSuccessful) {
        lesson.success_count += 1;
        lesson.confidence = Math.min(1.0, Math.round((lesson.confidence + 0.15 + feedbackDelta) * 100) / 100);
        lesson.correction = correction || lesson.correction;
        lesson.status = 'active';
      } else {
        lesson.failure_count += 1;
        lesson.confidence = Math.max(0.05, Math.round((lesson.confidence - 0.2 + feedbackDelta) * 100) / 100);
        if (lesson.confidence < 0.3) {
          lesson.status = 'disputed';
        }
      }
      lesson.last_observed_at = new Date().toISOString();
      lesson.evidence = evidence || lesson.evidence;
      if (feedback) {
        lesson.feedback_history = lesson.feedback_history || [];
        lesson.feedback_history.push({ ...feedback, timestamp: new Date().toISOString() });
      }
    } else {
      const initialConfidence = wasSuccessful ? (0.7 + feedbackDelta) : (0.3 + feedbackDelta);
      lesson = {
        id: uuidv4(),
        pattern_key: key,
        goal_id: goalId,
        situation_pattern: situationPattern,
        failure_category: failureCategory,
        evidence: evidence || 'Survival observation',
        correction,
        success_count: wasSuccessful ? 1 : 0,
        failure_count: wasSuccessful ? 0 : 1,
        confidence: Math.max(0.1, Math.min(1.0, Math.round(initialConfidence * 100) / 100)),
        status: wasSuccessful ? 'active' : 'disputed',
        feedback_history: feedback ? [{ ...feedback, timestamp: new Date().toISOString() }] : [],
        created_at: new Date().toISOString(),
        last_observed_at: new Date().toISOString()
      };
      this.lessons.push(lesson);
    }

    this.save();
    return lesson;
  }

  /**
   * Retrieves active, high-confidence lessons relevant to a goal or situation pattern.
   * @param {string} [goalId=null]
   * @param {string} [situationPattern=null]
   * @param {number} [minConfidence=0.3]
   * @returns {Array<Object>} Sorted by confidence descending
   */
  getRelevantLessons(goalId = null, situationPattern = null, minConfidence = 0.3) {
    return this.lessons.filter(l => {
      if (l.status === 'disputed' && l.confidence < minConfidence) return false;
      if (goalId && l.goal_id === goalId) return true;
      if (situationPattern && (l.situation_pattern === situationPattern || situationPattern.includes(l.pattern_key))) return true;
      return false;
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Records user chat feedback (!good / !bad) into persistent lessons and memories.
   * @param {Object} params
   * @param {string} [params.goalId]
   * @param {string} [params.situationPattern]
   * @param {boolean} params.isGood
   * @param {string} [params.message]
   * @returns {Object}
   */
  recordPlayerFeedback({ goalId, situationPattern, isGood, message = '' }) {
    const feedback = {
      type: isGood ? 'good' : 'bad',
      message
    };

    return this.storeSurvivalLesson({
      goalId,
      situationPattern: situationPattern || (goalId ? `${goalId}:behavior` : 'general:feedback'),
      failureCategory: isGood ? 'positive_reinforcement' : 'human_disapproval',
      evidence: `Player feedback: ${isGood ? '!good' : '!bad'} ${message}`,
      correction: isGood ? 'Reinforce this successful approach' : 'Avoid repeating this specific action sequence',
      wasSuccessful: isGood,
      feedback
    });
  }

  /**
   * Retrieves active, high-confidence memories relevant to a situation pattern.
   * @param {string} situationPattern
   * @param {number} [minConfidence=0.35]
   * @returns {Array<Object>}
   */
  findRelevantMemories(situationPattern, minConfidence = 0.35) {
    if (!situationPattern) return [];

    return this.memories.filter(m => {
      if (m.status === 'downgraded' || m.confidence < minConfidence) return false;
      return m.situation_pattern === situationPattern || 
             situationPattern.includes(m.situation_pattern) ||
             m.situation_pattern.includes(situationPattern);
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Explicitly marks a memory entry as stale or downgraded.
   * @param {string} id
   */
  downgradeMemory(id) {
    const entry = this.memories.find(m => m.id === id);
    if (entry) {
      entry.status = 'downgraded';
      entry.confidence = Math.max(0.1, entry.confidence - 0.3);
      this.save();
    }
  }

  /**
   * Records a successfully completed task/goal into persistent strategy memory.
   * Compares with previous executions to detect improvements (faster execution, better tool, higher yield).
   *
   * @param {Object} params
   * @param {string} params.goalId - Identifier of the goal achieved
   * @param {string} params.action - Action that succeeded
   * @param {Object} [params.args={}] - Arguments used
   * @param {number} [params.durationMs=0] - Execution duration in ms
   * @param {Object} [params.preObservation=null] - Snapshot before action
   * @param {Object} [params.postObservation=null] - Snapshot after action
   * @param {string} [params.improvementReason=null] - Optional reason why this attempt was an improvement
   * @returns {{ strategy: Object, isNew: boolean, isImprovement: boolean, previousBestDuration?: number }}
   */
  recordTaskCompletion({
    goalId,
    action,
    args = {},
    durationMs = 0,
    preObservation = null,
    postObservation = null,
    improvementReason = null
  }) {
    if (!goalId) return null;

    let strategy = this.strategies.find(s => s.goal_id === goalId);
    let isNew = false;
    let isImprovement = false;
    let previousBestDuration = 0;

    const heldTool = preObservation?.equipment?.mainhand?.name || null;
    const inventorySnapshot = (preObservation?.inventory || []).map(i => `${i.name}:${i.count}`);

    const toolTiersOrder = ['golden', 'wooden', 'stone', 'iron', 'diamond', 'netherite'];
    const getToolTierRank = (toolName) => {
      if (!toolName) return -1;
      for (let i = toolTiersOrder.length - 1; i >= 0; i--) {
        if (toolName.includes(toolTiersOrder[i])) return i + 1;
      }
      return 0;
    };

    if (strategy) {
      previousBestDuration = strategy.best_duration_ms || 0;
      strategy.total_completions += 1;
      strategy.last_used_at = new Date().toISOString();
      strategy.confidence = Math.min(1.0, Math.round((strategy.confidence + 0.1) * 100) / 100);

      // Improvement checks:
      // 1. Substantially faster (duration reduced by >= 15% when both > 0)
      // 2. Used an upgraded tool (e.g. upgraded from fists/wooden to stone/iron)
      // 3. Batch crafting efficiency (crafted higher quantity per step)
      // 4. Explicit improvement reason provided
      const isFaster = previousBestDuration > 0 && durationMs > 0 && durationMs < previousBestDuration * 0.85;
      const isToolUpgrade = Boolean(heldTool && getToolTierRank(heldTool) > getToolTierRank(strategy.optimal_tool));
      const isBatchUpgrade = Boolean(action === 'craft_item' && (args?.count || 1) > (strategy.args?.count || 1));

      if (isFaster || isToolUpgrade || isBatchUpgrade || improvementReason) {
        isImprovement = true;
        const reason = improvementReason || (
          isToolUpgrade
            ? `Upgraded tool from '${strategy.optimal_tool || 'unarmed'}' to '${heldTool}'`
            : isBatchUpgrade
              ? `Batch crafting efficiency increased (${args?.count} vs ${strategy.args?.count || 1})`
              : `Faster execution (${durationMs}ms vs ${previousBestDuration}ms)`
        );

        strategy.improvement_history.push({
          timestamp: new Date().toISOString(),
          previous_action: strategy.action,
          previous_args: strategy.args,
          previous_duration_ms: previousBestDuration,
          previous_tool: strategy.optimal_tool,
          improved_action: action,
          improved_args: args,
          improved_duration_ms: durationMs,
          improved_tool: heldTool,
          improvement_reason: reason
        });

        // Adopt new optimal parameters
        strategy.action = action;
        strategy.args = { ...args };
        if (heldTool) strategy.optimal_tool = heldTool;
        if (durationMs > 0) strategy.best_duration_ms = Math.min(strategy.best_duration_ms, durationMs);
        strategy.last_duration_ms = durationMs;
      } else {
        // Normal repeat success - update average duration
        if (durationMs > 0) {
          strategy.best_duration_ms = Math.min(strategy.best_duration_ms || durationMs, durationMs);
          strategy.average_duration_ms = Math.round(((strategy.average_duration_ms * (strategy.total_completions - 1)) + durationMs) / strategy.total_completions);
          strategy.last_duration_ms = durationMs;
        }
      }
    } else {
      isNew = true;
      strategy = {
        id: uuidv4(),
        goal_id: goalId,
        action,
        args: { ...args },
        optimal_tool: heldTool,
        total_completions: 1,
        best_duration_ms: durationMs || 0,
        average_duration_ms: durationMs || 0,
        last_duration_ms: durationMs || 0,
        confidence: 0.8,
        preconditions_summary: {
          held_tool: heldTool,
          key_items: inventorySnapshot.slice(0, 5)
        },
        improvement_history: [],
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString()
      };
      this.strategies.push(strategy);
    }

    this.save();
    return {
      strategy,
      isNew,
      isImprovement,
      previousBestDuration,
      improvementNote: isImprovement
        ? (strategy.improvement_history[strategy.improvement_history.length - 1]?.improvement_reason || 'Strategy improved')
        : null
    };
  }

  /**
   * Retrieves the proven optimal strategy for a given goal.
   * @param {string} goalId
   * @param {Object} [observation=null]
   * @returns {Object|null}
   */
  getBestStrategy(goalId, observation = null) {
    if (!goalId) return null;
    const strat = this.strategies.find(s => s.goal_id === goalId && s.confidence >= 0.5);
    return strat ? { ...strat } : null;
  }

  getTaskStrategy(goalId, observation = null) {
    return this.getBestStrategy(goalId, observation);
  }

  /**
   * Returns all recorded task strategies.
   * @returns {Array<Object>}
   */
  getAllStrategies() {
    return [...this.strategies];
  }

  /**
   * Normalizes location type aliases (e.g., 'shelter' and 'base').
   * @param {string} type
   * @returns {string}
   */
  normalizeLocationType(type) {
    if (!type) return 'unknown';
    const lower = String(type).toLowerCase().trim();
    if (lower === 'shelter' || lower === 'base' || lower === 'shelter_base' || lower === 'home') {
      return 'shelter_base';
    }
    if (lower === 'lost' || lower === 'lost_items' || lower === 'death_drop' || lower === 'lost_things') {
      return 'lost_things';
    }
    return lower;
  }

  /**
   * Records or updates a persistent location (e.g. shelter base, food, farm, lost things).
   * @param {string} type - Location type ('shelter', 'base', 'food', 'farm', 'lost_things')
   * @param {Object} position - { x, y, z } coordinates
   * @param {Object} [metadata={}] - Additional details (name, items, notes, dimension)
   * @returns {Object} Saved location entry
   */
  recordLocation(type, position, metadata = {}) {
    if (!position || position.x === undefined || position.z === undefined) {
      throw new Error("Invalid position: coordinates 'x' and 'z' are required");
    }

    const normalizedType = this.normalizeLocationType(type);
    const pos = {
      x: Math.round(Number(position.x) * 10) / 10,
      y: position.y !== undefined ? Math.round(Number(position.y) * 10) / 10 : 64,
      z: Math.round(Number(position.z) * 10) / 10
    };

    const dimension = metadata.dimension || 'overworld';
    const name = metadata.name || (
      normalizedType === 'shelter_base' ? 'Shelter Base' :
      normalizedType === 'food' ? 'Food Supply' :
      normalizedType === 'farm' ? 'Crop Farm' :
      normalizedType === 'lost_things' ? 'Lost Items (Death Drop)' :
      `${normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1)} Location`
    );

    // Look for existing nearby location of the same type within 8 blocks (or existing lost_things entry)
    let existing = null;
    if (normalizedType === 'lost_things') {
      // For lost_things, update/replace the current active lost things location
      existing = this.locations.find(l => l.type === 'lost_things');
    } else {
      existing = this.locations.find(l => {
        if (l.type !== normalizedType) return false;
        if (metadata.name && l.name === metadata.name) return true;
        const dist = Math.hypot(l.position.x - pos.x, l.position.z - pos.z);
        return dist <= 8.0;
      });
    }

    if (existing) {
      existing.position = pos;
      existing.dimension = dimension;
      existing.name = metadata.name || existing.name;
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.updated_at = new Date().toISOString();
      this.save();
      return existing;
    }

    const newLoc = {
      id: uuidv4(),
      type: normalizedType,
      name,
      position: pos,
      dimension,
      metadata: { ...metadata },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.locations.push(newLoc);
    this.save();
    return newLoc;
  }

  /**
   * Retrieves a primary location by type (supports 'shelter', 'base', 'food', 'farm', 'lost_things').
   * @param {string} type
   * @returns {Object|null}
   */
  getLocation(type) {
    if (!type) return null;
    const normalized = this.normalizeLocationType(type);
    const matches = this.locations.filter(l => l.type === normalized);
    if (matches.length === 0) return null;
    // Return the most recently updated location
    return matches.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  }

  /**
   * Retrieves all locations matching the given type (or all if not specified).
   * @param {string} [type=null]
   * @returns {Array<Object>}
   */
  getLocations(type = null) {
    if (!type) return [...this.locations];
    const normalized = this.normalizeLocationType(type);
    return this.locations.filter(l => l.type === normalized);
  }

  /**
   * Finds the nearest registered location of a given type to the specified coordinates.
   * @param {string} type
   * @param {Object} currentPosition - { x, y, z }
   * @returns {{ location: Object, distance: number }|null}
   */
  getNearestLocation(type, currentPosition) {
    if (!currentPosition || currentPosition.x === undefined || currentPosition.z === undefined) return null;
    const candidates = this.getLocations(type);
    if (candidates.length === 0) return null;

    let nearest = null;
    let minDistance = Infinity;

    for (const loc of candidates) {
      const dist = Math.hypot(loc.position.x - currentPosition.x, loc.position.z - currentPosition.z);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = loc;
      }
    }

    return nearest ? { location: nearest, distance: Math.round(minDistance * 10) / 10 } : null;
  }

  /**
   * Removes a location by its ID or by type.
   * @param {string} idOrType
   * @returns {boolean} Whether any location was removed
   */
  removeLocation(idOrType) {
    const initialLen = this.locations.length;
    const normalized = this.normalizeLocationType(idOrType);
    this.locations = this.locations.filter(l => l.id !== idOrType && l.type !== normalized);
    if (this.locations.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Clears locations matching type, or all if omitted.
   * @param {string} [type=null]
   */
  clearLocations(type = null) {
    if (type) {
      const normalized = this.normalizeLocationType(type);
      this.locations = this.locations.filter(l => l.type !== normalized);
    } else {
      this.locations = [];
    }
    this.save();
  }

  /**
   * Records dropped items / lost things location upon death.
   * @param {Object} position
   * @param {Array} [lostItems=[]]
   * @param {Object} [metadata={}]
   * @returns {Object}
   */
  recordLostThings(position, lostItems = [], metadata = {}) {
    return this.recordLocation('lost_things', position, {
      name: 'Lost Items (Death Drop)',
      lost_items: lostItems,
      lost_at: new Date().toISOString(),
      ...metadata
    });
  }

  /**
   * Retrieves active lost things location if any exists.
   * @returns {Object|null}
   */
  getLostThingsLocation() {
    return this.getLocation('lost_things');
  }

  /**
   * Clears lost things location (e.g. after items are successfully retrieved).
   */
  clearLostThings() {
    return this.removeLocation('lost_things');
  }

  /**
   * Records a death event with cause, location, inventory loss, and killer.
   * Automatically updates lost things location.
   *
   * @param {Object} params
   * @param {Object} params.position - Position where bot died
   * @param {string} [params.dimension='overworld']
   * @param {string} params.reason - Primary death reason (e.g. 'Slain by Zombie', 'Blown up by Creeper', 'Drowned')
   * @param {string} [params.deathMessage=null] - Full Minecraft chat death message
   * @param {string} [params.killer=null] - Killer entity / mob name
   * @param {string} [params.damageType=null] - Damage source type
   * @param {Array} [params.lostItems=[]] - Dropped inventory snapshot
   * @returns {Object} Death entry
   */
  recordDeath({
    position,
    dimension = 'overworld',
    reason,
    deathMessage = null,
    killer = null,
    damageType = null,
    lostItems = []
  }) {
    const pos = position ? {
      x: Math.round(Number(position.x) * 10) / 10,
      y: position.y !== undefined ? Math.round(Number(position.y) * 10) / 10 : 64,
      z: Math.round(Number(position.z) * 10) / 10
    } : null;

    const deathReason = reason || deathMessage || 'Unknown cause of death';

    const deathEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      reason: deathReason,
      death_message: deathMessage,
      killer: killer || null,
      damage_type: damageType || null,
      position: pos,
      dimension,
      lost_items: Array.isArray(lostItems) ? [...lostItems] : []
    };

    this.deathHistory.unshift(deathEntry);

    // Keep up to 20 past deaths
    if (this.deathHistory.length > 20) {
      this.deathHistory = this.deathHistory.slice(0, 20);
    }

    // Automatically record lost things location
    if (pos) {
      this.recordLostThings(pos, deathEntry.lost_items, {
        death_id: deathEntry.id,
        reason: deathReason,
        killer: deathEntry.killer,
        dimension
      });
    }

    this.save();
    return deathEntry;
  }

  /**
   * Updates the most recent death entry with official Minecraft server death message.
   * @param {string} deathMessage
   * @param {string} [killer=null]
   */
  updateLastDeathMessage(deathMessage, killer = null) {
    if (this.deathHistory.length > 0) {
      this.deathHistory[0].death_message = deathMessage;
      this.deathHistory[0].reason = deathMessage;
      if (killer) this.deathHistory[0].killer = killer;

      const lost = this.getLostThingsLocation();
      if (lost) {
        lost.metadata.reason = deathMessage;
        if (killer) lost.metadata.killer = killer;
      }
      this.save();
    }
  }

  /**
   * Returns details of the last death.
   * @returns {Object|null}
   */
  getLastDeathInfo() {
    return this.deathHistory[0] || null;
  }

  /**
   * Returns a readable summary of the last death reason.
   * @returns {string}
   */
  getLastDiedReason() {
    return this.deathHistory[0]?.reason || 'No recorded deaths';
  }

  /**
   * Returns complete history of recorded deaths.
   * @returns {Array<Object>}
   */
  getDeathHistory() {
    return [...this.deathHistory];
  }

  /**
   * Returns a structured summary of all known key survival locations.
   * @returns {{ shelter_base: Object|null, food: Object|null, farm: Object|null, lost_things: Object|null, last_died_reason: string, total_locations: number }}
   */
  getKnownLocationsSummary() {
    return {
      shelter_base: this.getLocation('shelter_base'),
      food: this.getLocation('food'),
      farm: this.getLocation('farm'),
      lost_things: this.getLostThingsLocation(),
      last_died_reason: this.getLastDiedReason(),
      total_locations: this.locations.length
    };
  }

  /**
   * Discovers and ingests lessons, recovery corrections, and task strategies
   * from validated experience and feedback records.
   * @param {Object} params
   * @param {Object[]} params.experiences - Validated and linked experiences
   * @param {Object[]} [params.feedbackRecords=[]] - Raw or linked feedback records
   * @returns {Object} Learning ingestion summary
   */
  learnFromDataset({ experiences = [], feedbackRecords = [] }) {
    let correctionsIngested = 0;
    let lessonsLearned = 0;
    let strategiesUpdated = 0;
    let deathsIngested = 0;

    for (const exp of experiences) {
      // 1. Ingest Failures with Verified Corrections / Recovery
      const isFailed = exp.execution?.status === 'failed' || Boolean(exp.learning?.failure_detected);
      const feedbackList = exp.learning?.feedback_records || [];

      if (isFailed) {
        const failureCategory = exp.learning?.failure_category || exp.execution?.error_code || 'unknown_failure';
        const attemptedAction = exp.decision?.action || 'unknown';
        const situationPattern = `${attemptedAction}:${failureCategory}`;
        const evidence = exp.execution?.error || `Action '${attemptedAction}' failed with ${failureCategory}`;

        // Look for linked corrections
        const correctionFeedbacks = feedbackList.filter(f => f.event_type === 'correction' || f.correction_proposed);
        for (const cf of correctionFeedbacks) {
          if (cf.correction_proposed) {
            const wasSuccessful = cf.retry_result === 'success' || exp.learning?.correction_verified === true;
            this.addOrUpdateCorrection({
              situationPattern,
              failureCategory,
              evidence: cf.feedback_text || evidence,
              correction: {
                action: cf.correction_proposed,
                arguments: {}
              },
              wasSuccessful
            });
            correctionsIngested++;

            this.storeSurvivalLesson({
              goalId: exp.goal || 'recovery',
              situationPattern,
              failureCategory,
              evidence: cf.feedback_text || evidence,
              correction: cf.correction_proposed,
              wasSuccessful,
              feedback: cf.label ? { type: cf.label === 'positive' ? 'good' : 'bad', message: cf.feedback_text } : null
            });
            lessonsLearned++;
          }
        }
      }

      // 2. Ingest Explicit Human Feedback Advice
      for (const fb of feedbackList) {
        if (fb.event_type === 'user_feedback' && fb.feedback_text) {
          const lower = fb.feedback_text.toLowerCase();
          let adviceSituation = null;
          let adviceAction = null;

          if (lower.includes('shelter')) {
            adviceSituation = 'night:danger';
            adviceAction = 'build_emergency_shelter';
          } else if (lower.includes('bed')) {
            adviceSituation = 'night:rest';
            adviceAction = 'craft_bed';
          } else if (lower.includes('food')) {
            adviceSituation = 'low_hunger';
            adviceAction = 'eat_food';
          } else if (lower.includes('wood')) {
            adviceSituation = 'early_game:resources';
            adviceAction = 'collect_wood';
          }

          if (adviceSituation && adviceAction) {
            this.storeSurvivalLesson({
              goalId: exp.goal || 'survival',
              situationPattern: adviceSituation,
              failureCategory: 'human_guidance',
              evidence: fb.feedback_text,
              correction: adviceAction,
              wasSuccessful: fb.label === 'positive',
              feedback: { type: fb.label === 'positive' ? 'good' : 'bad', message: fb.feedback_text }
            });
            lessonsLearned++;
          }
        }
      }

      // 3. Ingest Successful Task Completions into Strategies
      if (exp.execution?.status === 'success' && exp.outcome?.task_progress > 0 && exp.decision?.action) {
        const goalId = exp.decision.goal || exp.goal || 'task';
        const duration = exp.execution.duration_ms || 1000;
        const res = this.recordTaskCompletion({
          goalId,
          action: exp.decision.action,
          args: exp.decision.arguments || {},
          durationMs: duration,
          preObservation: exp.observation_before,
          postObservation: exp.observation_after
        });
        if (res) strategiesUpdated++;
      }

      // 4. Ingest Death Records
      if (exp.goal === 'death event record' || (exp.observation_before?.agent && exp.observation_before.agent.isAlive === false)) {
        const pos = exp.observation_before?.agent?.position || { x: 0, y: 64, z: 0 };
        const reason = exp.learning?.failure_category || 'Fatal hazard';
        this.recordDeath({
          position: pos,
          dimension: exp.environment?.dimension || 'overworld',
          reason,
          lostItems: exp.observation_before?.inventory || []
        });
        deathsIngested++;
      }
    }

    this.save();

    return {
      correctionsIngested,
      lessonsLearned,
      strategiesUpdated,
      deathsIngested,
      totalMemories: this.memories.length,
      totalLessons: this.lessons.length,
      totalStrategies: this.strategies.length
    };
  }

  /**
   * Clears memory, lessons, strategies, locations, and death history (useful in tests).
   */
  clear() {
    this.memories = [];
    this.lessons = [];
    this.strategies = [];
    this.locations = [];
    this.deathHistory = [];
    this.save();
  }
}

export const defaultMemoryStore = new PersistentMemoryStore();
export default defaultMemoryStore;
