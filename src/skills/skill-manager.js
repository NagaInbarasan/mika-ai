import fs from 'fs';
import path from 'path';
import config from '../config/index.js';

/**
 * MIKA V1.3 - Persistent Skill Repository & Lifecycle Manager
 * 
 * Manages learned, reusable skills separate from raw experiences:
 * - Persistent storage in data/skills/
 * - Schema validation for learned skill records
 * - Metric tracking (completion rate, construction duration, placement failures, recovery rate)
 * - Reuse across different worlds and terrain layouts
 */

export class SkillManager {
  constructor(options = {}) {
    this.skillsDir = options.skillsDir || path.join(config.storage.dataDir, 'skills');
    this.indexPath = path.join(this.skillsDir, 'index.json');
    this.cache = new Map();
    this._ensureDir();
    this.loadIndex();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.skillsDir)) {
        fs.mkdirSync(this.skillsDir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[SkillManager] Error creating skills directory: ${err.message}`);
    }
  }

  loadIndex() {
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, 'utf-8');
        const list = JSON.parse(raw);
        for (const item of list) {
          if (item?.skill_id) {
            this.cache.set(item.skill_id, item);
          }
        }
      }
    } catch (err) {
      console.warn(`[SkillManager] Error loading skill index: ${err.message}`);
    }
  }

  saveIndex() {
    try {
      this._ensureDir();
      const list = Array.from(this.cache.values()).map(s => ({
        skill_id: s.skill_id,
        name: s.name,
        version: s.version,
        purpose: s.purpose,
        updated_at: s.updated_at || new Date().toISOString(),
        completion_rate: s.evaluation_metrics?.completion_rate ?? 1.0,
        total_runs: s.evaluation_metrics?.total_runs ?? 1
      }));
      fs.writeFileSync(this.indexPath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[SkillManager] Error saving skill index: ${err.message}`);
    }
  }

  /**
   * Saves a validated learned skill to persistent storage.
   * @param {Object} skillRecord 
   * @returns {Object} Saved skill record
   */
  saveSkill(skillRecord) {
    if (!skillRecord || !skillRecord.skill_id) {
      throw new Error('Skill record must provide a unique skill_id');
    }

    this._ensureDir();
    const filePath = path.join(this.skillsDir, `${skillRecord.skill_id}.json`);
    
    const enrichedRecord = {
      ...skillRecord,
      saved_at: skillRecord.saved_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    fs.writeFileSync(filePath, JSON.stringify(enrichedRecord, null, 2), 'utf-8');
    this.cache.set(skillRecord.skill_id, enrichedRecord);
    this.saveIndex();

    console.log(`[SkillManager] Saved learned skill '${skillRecord.skill_id}' (v${skillRecord.version || '1.3.0'}) to ${filePath}`);
    return enrichedRecord;
  }

  /**
   * Loads a learned skill by identifier.
   * @param {string} skillId 
   * @returns {Object|null}
   */
  loadSkill(skillId) {
    if (!skillId) return null;
    const filePath = path.join(this.skillsDir, `${skillId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.cache.set(skillId, parsed);
        return parsed;
      }
    } catch (err) {
      console.warn(`[SkillManager] Error reading skill ${skillId}: ${err.message}`);
    }
    return this.cache.get(skillId) || null;
  }

  /**
   * Checks if a skill is available in persistent memory.
   * @param {string} skillId 
   * @returns {boolean}
   */
  hasSkill(skillId) {
    if (this.cache.has(skillId)) return true;
    const filePath = path.join(this.skillsDir, `${skillId}.json`);
    return fs.existsSync(filePath);
  }

  /**
   * Lists all available learned skills.
   * @returns {Array<Object>}
   */
  listSkills() {
    return Array.from(this.cache.values());
  }

  /**
   * Updates execution metrics after applying the skill in a world.
   * @param {string} skillId 
   * @param {Object} metrics 
   */
  recordExecution(skillId, metrics = {}) {
    const skill = this.loadSkill(skillId);
    if (!skill) return null;

    if (!skill.evaluation_metrics) {
      skill.evaluation_metrics = {
        total_runs: 0,
        successful_runs: 0,
        completion_rate: 1.0,
        avg_duration_ms: 0,
        total_placement_failures: 0,
        total_threat_interruptions: 0,
        total_recovery_successes: 0
      };
    }

    const em = skill.evaluation_metrics;
    em.total_runs += 1;
    if (metrics.success) em.successful_runs += 1;
    em.completion_rate = Math.round((em.successful_runs / em.total_runs) * 100) / 100;
    
    if (metrics.duration_ms) {
      em.avg_duration_ms = Math.round(
        ((em.avg_duration_ms * (em.total_runs - 1)) + metrics.duration_ms) / em.total_runs
      );
    }

    if (metrics.placement_failures) em.total_placement_failures += metrics.placement_failures;
    if (metrics.threat_interruptions) em.total_threat_interruptions += metrics.threat_interruptions;
    if (metrics.recovery_success) em.total_recovery_successes += 1;

    return this.saveSkill(skill);
  }
}

export const defaultSkillManager = new SkillManager();
export default defaultSkillManager;
