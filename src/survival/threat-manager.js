import { Vec3 } from 'vec3';

/**
 * MIKA V1.3 - Priority and Threat Management Engine
 * 
 * Implements:
 * - 6-Tier persistent priority hierarchy
 * - Persistent threat tracking (does NOT assume mob vanished when losing sight)
 * - Tactical threat evaluation: Retreat to safe shelter vs Combat vs Tactical Flee
 * - Emergency interruption coordination with TaskManager
 * - Threat resolution and task resumption
 */

export const THREAT_TIERS = Object.freeze({
  TIER_1_IMMEDIATE_SURVIVAL: 1,
  TIER_2_ESCAPE_OR_COMBAT: 2,
  TIER_3_ACTIVE_OBJECTIVE: 3,
  TIER_4_MAINTAIN_SUPPLIES: 4,
  TIER_5_BASE_IMPROVEMENT: 5,
  TIER_6_EXPLORATION: 6
});

export const HOSTILE_MOBS = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'husk', 'phantom'];

export class ThreatManager {
  constructor(options = {}) {
    this.threatMemoryTtlMs = options.threatMemoryTtlMs || 15000; // 15 seconds persistence after sight lost
    this.trackedThreats = new Map(); // entityId -> { name, position, lastSeen, distance, dangerous }
    this.activeThreatResponse = null;
  }

  /**
   * Updates tracked threats from observation, maintaining persistence for recently seen threats.
   * 
   * @param {Object} obs
   * @param {Object} botPos
   * @returns {Array<Object>} Currently active tracked threats
   */
  updateThreatTracking(obs, botPos = null) {
    const now = Date.now();
    const observedThreats = obs?.nearby_threats || [];

    // 1. Record newly observed threats
    for (const threat of observedThreats) {
      this.trackedThreats.set(threat.id || threat.name, {
        id: threat.id || threat.name,
        name: threat.name,
        position: threat.position,
        distance: threat.distance,
        isDirectSight: true,
        lastSeen: now
      });
    }

    // 2. Age out threats that haven't been seen for > TTL
    for (const [id, threat] of this.trackedThreats.entries()) {
      if (now - threat.lastSeen > this.threatMemoryTtlMs) {
        this.trackedThreats.delete(id);
      } else if (now - threat.lastSeen > 2000) {
        threat.isDirectSight = false; // Persistent memory: temporarily lost sight but still assumed nearby!
      }
    }

    // Recalculate distances if botPos provided
    if (botPos) {
      for (const threat of this.trackedThreats.values()) {
        if (threat.position) {
          threat.distance = Math.hypot(threat.position.x - botPos.x, threat.position.z - botPos.z);
        }
      }
    }

    return Array.from(this.trackedThreats.values()).sort((a, b) => a.distance - b.distance);
  }

  /**
   * Evaluates threat level and selects the safest tactical response.
   * 
   * @param {Object} obs
   * @param {Object} [shelterInfo=null]
   * @returns {{ action: string, threat: Object|null, reason: string, priorityTier: number }}
   */
  evaluateThreatResponse(obs, shelterInfo = null) {
    const botPos = obs?.agent?.position;
    const activeThreats = this.updateThreatTracking(obs, botPos);
    const health = obs?.agent?.health ?? 20;
    const inv = obs?.inventory || [];

    if (activeThreats.length === 0) {
      this.activeThreatResponse = null;
      return { action: 'NONE', threat: null, reason: 'No active threats detected', priorityTier: THREAT_TIERS.TIER_3_ACTIVE_OBJECTIVE };
    }

    const closest = activeThreats[0];
    const isSheltered = shelterInfo?.isSafe || obs?.shelter_safety?.safe;
    const distToShelter = shelterInfo?.distance || Infinity;
    const hasSword = inv.some(i => i.name.includes('_sword'));
    const hasShield = inv.some(i => i.name === 'shield') || obs?.equipment?.offhand?.name === 'shield';

    // Critical danger (Tier 1)
    if (health <= 6 || closest.distance <= 2.5) {
      // If safe shelter reachable within 20m, retreat inside
      if (distToShelter <= 20 && shelterInfo?.position) {
        return {
          action: 'RETREAT_TO_SHELTER',
          targetPos: shelterInfo.position,
          threat: closest,
          reason: `Critical health (${health}) or proximity (${closest.distance.toFixed(1)}m); retreating into safe shelter`,
          priorityTier: THREAT_TIERS.TIER_1_IMMEDIATE_SURVIVAL
        };
      }

      // Otherwise flee
      return {
        action: 'FLEE',
        threat: closest,
        reason: `Critical health (${health}) or close danger; fleeing to safe distance`,
        priorityTier: THREAT_TIERS.TIER_1_IMMEDIATE_SURVIVAL
      };
    }

    // Moderate threat (Tier 2): Evaluate Shelter Retreat vs Safe Combat vs Flee
    if (isSheltered) {
      return {
        action: 'STAY_SHELTERED',
        threat: closest,
        reason: `Threat outside (${closest.distance.toFixed(1)}m); remaining inside safe shelter`,
        priorityTier: THREAT_TIERS.TIER_2_ESCAPE_OR_COMBAT
      };
    }

    if (distToShelter <= 25 && shelterInfo?.position) {
      return {
        action: 'RETREAT_TO_SHELTER',
        targetPos: shelterInfo.position,
        threat: closest,
        reason: `Threat detected (${closest.name} at ${closest.distance.toFixed(1)}m); retreating to shelter`,
        priorityTier: THREAT_TIERS.TIER_2_ESCAPE_OR_COMBAT
      };
    }

    // Fight condition: high health, equipped sword, solitary non-creeper mob
    const isFightable = (closest.name === 'zombie' || closest.name === 'spider') &&
                        activeThreats.length === 1 &&
                        health >= 14 &&
                        hasSword;

    if (isFightable) {
      return {
        action: 'ENGAGE_COMBAT',
        threat: closest,
        reason: `Controlled combat engagement against solitary ${closest.name} (Health: ${health}, Sword equipped)`,
        priorityTier: THREAT_TIERS.TIER_2_ESCAPE_OR_COMBAT
      };
    }

    // Default response: flee from danger
    return {
      action: 'FLEE',
      threat: closest,
      reason: `Unfavorable combat conditions (${closest.name}, distance ${closest.distance.toFixed(1)}m); fleeing`,
      priorityTier: THREAT_TIERS.TIER_2_ESCAPE_OR_COMBAT
    };
  }

  /**
   * Clears a threat after it is confirmed killed or despawned.
   */
  clearThreat(threatId) {
    this.trackedThreats.delete(threatId);
  }

  reset() {
    this.trackedThreats.clear();
    this.activeThreatResponse = null;
  }
}

export const defaultThreatManager = new ThreatManager();
export default defaultThreatManager;
