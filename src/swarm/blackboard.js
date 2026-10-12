/**
 * Swarm Spatial & Resource Blackboard.
 * Provides a shared decentralized memory blackboard for all bots in the swarm.
 * Tracks shared base/shelter coordinates, storage chests, resource veins,
 * active mob threats, distress signals, and teammate statuses.
 */

import { v4 as uuidv4 } from 'uuid';
import { defaultMemoryStore } from '../learning/memory.js';

export class SwarmBlackboard {
  constructor(options = {}) {
    this.swarmId = options.swarmId || `swarm-${Date.now()}`;
    this.memoryStore = options.memoryStore || defaultMemoryStore;
    this.shelter = null;
    this.farms = [];
    this.foodSources = [];
    this.furniture = []; // [{ id, type, x, y, z, placedBy, timestamp }]
    this.waypoints = []; // [{ id, name, type, x, y, z, tags, markedBy, timestamp }]
    this.animals = new Map(); // key -> { key, type, x, y, z, spottedBy, timestamp }
    this.lostThings = null;
    this.chests = [];
    this.resources = new Map(); // key -> resource object
    this.threats = new Map(); // key -> threat object
    this.distressCalls = new Map(); // id -> distress object
    this.resourceRequests = new Map(); // id -> request object
    this.creatureEncounters = new Map(); // creatureName -> { kills, lastSeen, drops: Set, locations: [] }
    this.foodRequests = new Map(); // id -> food request object
    this.members = new Map(); // botName -> member state
    this.stats = {
      resourcesCollected: {},
      threatsDefeated: 0,
      rescuesPerformed: 0,
      itemsShared: 0,
      sheltersBuilt: 0,
      furniturePlaced: 0,
      farmsHarvested: 0,
      animalsHunted: 0,
      waypointsMarked: 0
    };

    if (options.autoHydrate !== false) {
      this.hydrateFromMemory();
    }
  }

  /**
   * Resets the blackboard to clean state.
   */
  reset() {
    this.shelter = null;
    this.farms = [];
    this.foodSources = [];
    this.furniture = [];
    this.waypoints = [];
    this.animals.clear();
    this.lostThings = null;
    this.chests = [];
    this.resources.clear();
    this.threats.clear();
    this.distressCalls.clear();
    this.resourceRequests.clear();
    this.creatureEncounters.clear();
    this.foodRequests.clear();
    this.members.clear();
  }

  /**
   * Preloads spatial knowledge from PersistentMemoryStore into SwarmBlackboard.
   */
  hydrateFromMemory() {
    if (!this.memoryStore) return;
    try {
      const locs = this.memoryStore.locations || [];
      for (const loc of locs) {
        if (!loc || !loc.position) continue;
        const type = loc.type;

        if ((type === 'shelter' || type === 'shelter_base' || type === 'base') && !this.shelter) {
          this.shelter = {
            x: Math.round(loc.position.x),
            y: Math.round(loc.position.y),
            z: Math.round(loc.position.z),
            isSafe: loc.metadata?.is_safe !== false,
            builtBy: loc.metadata?.builtBy || 'memory',
            timestamp: loc.timestamp || Date.now()
          };
        } else if (type === 'farm') {
          if (!this.farms.some(f => Math.hypot(f.x - loc.position.x, f.z - loc.position.z) < 2)) {
            this.farms.push({
              id: loc.id,
              x: Math.round(loc.position.x),
              y: Math.round(loc.position.y),
              z: Math.round(loc.position.z),
              crop: loc.metadata?.crop || 'wheat',
              registeredBy: loc.metadata?.registeredBy || 'memory',
              timestamp: loc.timestamp || Date.now()
            });
          }
        } else if (type === 'food') {
          if (!this.foodSources.some(f => Math.hypot(f.x - loc.position.x, f.z - loc.position.z) < 2)) {
            this.foodSources.push({
              id: loc.id,
              x: Math.round(loc.position.x),
              y: Math.round(loc.position.y),
              z: Math.round(loc.position.z),
              type: loc.metadata?.food_type || loc.metadata?.type || 'food',
              discoveredBy: loc.metadata?.discoveredBy || 'memory',
              timestamp: loc.timestamp || Date.now()
            });
          }
        } else if (type === 'chest') {
          if (!this.chests.some(c => Math.hypot(c.x - loc.position.x, c.z - loc.position.z) < 2)) {
            this.chests.push({
              id: loc.id,
              x: Math.round(loc.position.x),
              y: Math.round(loc.position.y),
              z: Math.round(loc.position.z),
              registeredBy: loc.metadata?.registeredBy || 'memory',
              timestamp: loc.timestamp || Date.now()
            });
          }
        } else if (['crafting_table', 'furnace', 'bed', 'torch', 'door'].includes(type)) {
          if (!this.furniture.some(f => f.type === type && Math.hypot(f.x - loc.position.x, f.z - loc.position.z) < 2)) {
            this.furniture.push({
              id: loc.id,
              type,
              x: Math.round(loc.position.x),
              y: Math.round(loc.position.y),
              z: Math.round(loc.position.z),
              placedBy: loc.metadata?.placedBy || 'memory',
              timestamp: loc.timestamp || Date.now()
            });
          }
        } else if (type === 'waypoint') {
          this.waypoints.push({
            id: loc.id,
            name: loc.name || 'Waypoint',
            type,
            x: Math.round(loc.position.x),
            y: Math.round(loc.position.y),
            z: Math.round(loc.position.z),
            tags: loc.metadata?.tags || [],
            markedBy: loc.metadata?.markedBy || 'memory',
            timestamp: loc.timestamp || Date.now()
          });
        }
      }

      if (typeof this.memoryStore.getLostThingsLocation === 'function') {
        const death = this.memoryStore.getLostThingsLocation();
        if (death && death.position) {
          this.lostThings = {
            x: Math.round(death.position.x),
            y: Math.round(death.position.y),
            z: Math.round(death.position.z),
            botName: death.metadata?.botName || 'teammate',
            reason: death.metadata?.reason || 'death',
            lostItems: death.metadata?.lost_items || [],
            timestamp: death.timestamp || Date.now()
          };
        }
      }
    } catch (err) {
      console.warn('[Swarm Blackboard] Memory hydration warning:', err.message);
    }
  }

  // --- Member State ---

  updateMemberState(botName, state = {}) {
    if (!botName) return;
    const existing = this.members.get(botName) || {
      name: botName,
      role: 'unassigned',
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      currentTask: 'idle',
      isAlive: true
    };

    const updated = {
      ...existing,
      ...state,
      name: botName,
      lastSeen: Date.now()
    };
    this.members.set(botName, updated);
    return updated;
  }

  getMember(botName) {
    return this.members.get(botName) || null;
  }

  getAllMembers() {
    return Array.from(this.members.values());
  }

  getNearestTeammate(fromPos, excludeName = null) {
    let nearest = null;
    let minDist = Infinity;

    for (const [name, member] of this.members.entries()) {
      if (name === excludeName || !member.isAlive || !member.position) continue;
      const d = Math.hypot(member.position.x - fromPos.x, member.position.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...member, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  // --- Base & Shelter ---

  registerShelter(shelterData) {
    this.shelter = {
      x: Math.round(shelterData.x),
      y: Math.round(shelterData.y),
      z: Math.round(shelterData.z),
      isSafe: shelterData.isSafe !== undefined ? shelterData.isSafe : true,
      builtBy: shelterData.builtBy || 'unknown',
      timestamp: Date.now()
    };
    this.stats.sheltersBuilt += 1;
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation('shelter', this.shelter, {
        is_safe: this.shelter.isSafe,
        builtBy: this.shelter.builtBy
      });
    }
    return this.shelter;
  }

  getShelter() {
    return this.shelter;
  }

  // --- Storage Chests ---

  registerChest(chestData) {
    const chest = {
      id: chestData.id || `chest-${this.chests.length + 1}`,
      x: Math.round(chestData.x),
      y: Math.round(chestData.y),
      z: Math.round(chestData.z),
      category: chestData.category || 'general', // 'food' | 'minerals' | 'building' | 'general'
      registeredBy: chestData.registeredBy || 'unknown',
      timestamp: Date.now()
    };
    this.chests.push(chest);
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation('chest', chest, {
        category: chest.category,
        registeredBy: chest.registeredBy
      });
    }
    return chest;
  }

  getNearestChest(fromPos, category = null) {
    if (this.chests.length === 0) return null;
    let nearest = null;
    let minDist = Infinity;
    for (const chest of this.chests) {
      if (category && chest.category !== category && chest.category !== 'general') continue;
      const d = Math.hypot(chest.x - fromPos.x, chest.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...chest, distance: Math.round(d * 10) / 10 };
      }
    }
    // Fallback to any chest if no category-specific chest found
    if (!nearest && category) {
      return this.getNearestChest(fromPos, null);
    }
    return nearest;
  }

  // --- Furniture (Workbench, Furnace, Bed, Torches, Doors) ---

  registerFurniture({ type, x, y, z, placedBy = 'unknown' }) {
    const item = {
      id: `furn-${this.furniture.length + 1}`,
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      placedBy,
      timestamp: Date.now()
    };
    this.furniture.push(item);
    this.stats.furniturePlaced = (this.stats.furniturePlaced || 0) + 1;
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation(type, item, { placedBy });
    }
    return item;
  }

  getFurniture(type = null, fromPos = null) {
    const matches = this.furniture.filter(f => !type || f.type === type);
    if (matches.length === 0) return null;
    if (!fromPos) return matches[0];
    let nearest = null;
    let minDist = Infinity;
    for (const item of matches) {
      const d = Math.hypot(item.x - fromPos.x, item.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...item, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  getAllFurniture() {
    return [...this.furniture];
  }

  // --- Farms ---

  registerFarm(farmData) {
    const farm = {
      id: farmData.id || `farm-${this.farms.length + 1}`,
      x: Math.round(farmData.x),
      y: Math.round(farmData.y),
      z: Math.round(farmData.z),
      crop: farmData.crop || 'wheat',
      registeredBy: farmData.registeredBy || 'unknown',
      timestamp: Date.now()
    };
    this.farms.push(farm);
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation('farm', farm, {
        crop: farm.crop,
        registeredBy: farm.registeredBy
      });
    }
    return farm;
  }

  getNearestFarm(fromPos) {
    if (this.farms.length === 0) return null;
    let nearest = null;
    let minDist = Infinity;
    for (const farm of this.farms) {
      const d = Math.hypot(farm.x - fromPos.x, farm.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...farm, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  getAllFarms() {
    return [...this.farms];
  }

  // --- Food Sources & Animal Hunting ---

  registerFoodSource(foodData) {
    const source = {
      id: foodData.id || `food-${this.foodSources.length + 1}`,
      x: Math.round(foodData.x),
      y: Math.round(foodData.y),
      z: Math.round(foodData.z),
      type: foodData.type || 'food',
      discoveredBy: foodData.discoveredBy || 'unknown',
      timestamp: Date.now()
    };
    this.foodSources.push(source);
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation('food', source, {
        food_type: source.type,
        discoveredBy: source.discoveredBy
      });
    }
    return source;
  }

  getNearestFoodSource(fromPos) {
    if (this.foodSources.length === 0) return null;
    let nearest = null;
    let minDist = Infinity;
    for (const food of this.foodSources) {
      const d = Math.hypot(food.x - fromPos.x, food.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...food, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  getAllFoodSources() {
    return [...this.foodSources];
  }

  registerAnimalHerd({ type, x, y, z, spottedBy = 'unknown' }) {
    const key = `${type}_${Math.round(x)}_${Math.round(z)}`;
    const animal = {
      key,
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      spottedBy,
      timestamp: Date.now()
    };
    this.animals.set(key, animal);
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation('animal_herd', animal, { type, spottedBy });
    }
    return animal;
  }

  getNearestAnimal(fromPos, type = null) {
    let nearest = null;
    let minDist = Infinity;
    for (const an of this.animals.values()) {
      if (type && an.type !== type) continue;
      const d = Math.hypot(an.x - fromPos.x, an.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...an, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  removeAnimal(keyOrType, pos = null) {
    if (pos) {
      const key = `${keyOrType}_${Math.round(pos.x)}_${Math.round(pos.z)}`;
      return this.animals.delete(key);
    }
    return this.animals.delete(keyOrType);
  }

  // --- Map Drawing & Waypoint Marking ---

  registerWaypoint({ name, type = 'waypoint', x, y, z, tags = [], markedBy = 'unknown' }) {
    const wp = {
      id: `wp-${this.waypoints.length + 1}`,
      name: name || `Waypoint #${this.waypoints.length + 1}`,
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      tags,
      markedBy,
      timestamp: Date.now()
    };
    this.waypoints.push(wp);
    this.stats.waypointsMarked = (this.stats.waypointsMarked || 0) + 1;
    if (this.memoryStore && typeof this.memoryStore.recordLocation === 'function') {
      this.memoryStore.recordLocation(type, wp, { name: wp.name, tags, markedBy });
    }
    return wp;
  }

  getAllWaypoints() {
    return [...this.waypoints];
  }

  getNearestWaypoint(fromPos, type = null) {
    const candidates = this.waypoints.filter(w => !type || w.type === type);
    if (candidates.length === 0) return null;
    let nearest = null;
    let minDist = Infinity;
    for (const wp of candidates) {
      const d = Math.hypot(wp.x - fromPos.x, wp.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...wp, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  // --- Lost Things (Death Drops) ---

  registerLostThings(lostData) {
    this.lostThings = {
      x: Math.round(lostData.x),
      y: Math.round(lostData.y),
      z: Math.round(lostData.z),
      botName: lostData.botName || 'unknown',
      reason: lostData.reason || 'died',
      lostItems: lostData.lostItems || [],
      timestamp: Date.now()
    };
    if (this.memoryStore && typeof this.memoryStore.recordDeath === 'function') {
      this.memoryStore.recordDeath(
        { x: this.lostThings.x, y: this.lostThings.y, z: this.lostThings.z },
        this.lostThings.reason,
        this.lostThings.lostItems
      );
    }
    return this.lostThings;
  }

  getLostThings() {
    return this.lostThings;
  }

  clearLostThings() {
    this.lostThings = null;
  }

  // --- Resources ---

  registerResource({ type, x, y, z, count = 1, discoveredBy = 'unknown' }) {
    const key = `${type}_${Math.round(x)}_${Math.round(z)}`;
    const resource = {
      key,
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      count,
      discoveredBy,
      timestamp: Date.now()
    };
    this.resources.set(key, resource);
    return resource;
  }

  getNearestResource(type, fromPos) {
    let nearest = null;
    let minDist = Infinity;

    for (const res of this.resources.values()) {
      if (type && res.type !== type) continue;
      const d = Math.hypot(res.x - fromPos.x, res.z - fromPos.z);
      if (d < minDist) {
        minDist = d;
        nearest = { ...res, distance: Math.round(d * 10) / 10 };
      }
    }
    return nearest;
  }

  removeResource(keyOrType, pos = null) {
    if (pos) {
      const key = `${keyOrType}_${Math.round(pos.x)}_${Math.round(pos.z)}`;
      return this.resources.delete(key);
    }
    return this.resources.delete(keyOrType);
  }

  recordResourceCollected(type, count = 1) {
    this.stats.resourcesCollected[type] = (this.stats.resourcesCollected[type] || 0) + count;
  }

  // --- Distress Calls ---

  postDistressCall({ botName, position, mobName = 'hostile_mob', health = 6 }) {
    const id = `distress-${uuidv4().slice(0, 8)}`;
    const call = {
      id,
      botName,
      position: { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) },
      mobName,
      health,
      status: 'active',
      handledBy: null,
      timestamp: Date.now()
    };
    this.distressCalls.set(id, call);
    return call;
  }

  getActiveDistressCalls() {
    return Array.from(this.distressCalls.values()).filter(c => c.status === 'active');
  }

  claimDistressCall(id, handledBy) {
    const call = this.distressCalls.get(id);
    if (call && call.status === 'active') {
      call.status = 'claimed';
      call.handledBy = handledBy;
      return call;
    }
    return null;
  }

  resolveDistressCall(id, resolvedBy) {
    const call = this.distressCalls.get(id);
    if (call) {
      call.status = 'resolved';
      call.resolvedBy = resolvedBy;
      this.stats.rescuesPerformed += 1;
      this.stats.threatsDefeated += 1;
      return call;
    }
    return null;
  }

  // --- Resource Requests & Aid ---

  postResourceRequest({ botName, resource, count = 1, position }) {
    const id = `req-${uuidv4().slice(0, 8)}`;
    const req = {
      id,
      botName,
      resource,
      count,
      position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null,
      status: 'open',
      fulfilledBy: null,
      timestamp: Date.now()
    };
    this.resourceRequests.set(id, req);
    return req;
  }

  getActiveResourceRequests() {
    return Array.from(this.resourceRequests.values()).filter(r => r.status === 'open');
  }

  fulfillResourceRequest(id, fulfilledBy) {
    const req = this.resourceRequests.get(id);
    if (req) {
      req.status = 'fulfilled';
      req.fulfilledBy = fulfilledBy;
      this.stats.itemsShared += req.count;
      return req;
    }
    return null;
  }

  // --- Threats ---

  registerThreat({ mob, x, y, z, reportedBy = 'unknown', severity = 'medium' }) {
    const key = `${mob}_${Math.round(x)}_${Math.round(z)}`;
    const threat = {
      key,
      mob,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      reportedBy,
      severity,
      timestamp: Date.now()
    };
    this.threats.set(key, threat);
    return threat;
  }

  getActiveThreats() {
    return Array.from(this.threats.values());
  }

  removeThreat(key) {
    return this.threats.delete(key);
  }

  // --- Creature Encounter Tracking ---

  recordCreatureEncounter({ creature, x, y, z, killed = false, drops = [], reportedBy = 'unknown' }) {
    const existing = this.creatureEncounters.get(creature) || {
      creature,
      kills: 0,
      lastSeen: null,
      lastPosition: null,
      drops: new Set(),
      locations: [],
      firstSeen: Date.now()
    };
    existing.lastSeen = Date.now();
    existing.lastPosition = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    if (killed) existing.kills += 1;
    for (const d of drops) existing.drops.add(d);
    // Keep last 5 sighting locations
    existing.locations.push({ x: Math.round(x), z: Math.round(z), timestamp: Date.now() });
    if (existing.locations.length > 5) existing.locations.shift();
    this.creatureEncounters.set(creature, existing);
    return existing;
  }

  getCreatureEncounter(creature) {
    return this.creatureEncounters.get(creature) || null;
  }

  getAllCreatureEncounters() {
    return Array.from(this.creatureEncounters.values());
  }

  getNearestCreatureSighting(creatureType, fromPos) {
    const encounter = this.creatureEncounters.get(creatureType);
    if (!encounter || !encounter.lastPosition) return null;
    const d = Math.hypot(encounter.lastPosition.x - fromPos.x, (encounter.lastPosition.z || 0) - fromPos.z);
    return { ...encounter, distance: Math.round(d * 10) / 10 };
  }

  // --- Food Request System ---

  postFoodRequest({ botName, position, urgency = 'normal' }) {
    // Don't duplicate active requests from same bot
    for (const req of this.foodRequests.values()) {
      if (req.botName === botName && req.status === 'open') return req;
    }
    const id = `food-req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const req = {
      id,
      botName,
      position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null,
      urgency, // 'critical' | 'normal'
      status: 'open', // 'open' | 'claimed' | 'fulfilled'
      claimedBy: null,
      timestamp: Date.now()
    };
    this.foodRequests.set(id, req);
    return req;
  }

  getActiveFoodRequests() {
    return Array.from(this.foodRequests.values()).filter(r => r.status === 'open');
  }

  claimFoodRequest(id, claimedBy) {
    const req = this.foodRequests.get(id);
    if (req && req.status === 'open') {
      req.status = 'claimed';
      req.claimedBy = claimedBy;
      return req;
    }
    return null;
  }

  fulfillFoodRequest(id, fulfilledBy) {
    const req = this.foodRequests.get(id);
    if (req) {
      req.status = 'fulfilled';
      req.fulfilledBy = fulfilledBy;
      return req;
    }
    return null;
  }

  // --- Staleness Management ---

  purgeStaleData(maxAgeMs = 300000) {
    const now = Date.now();
    // Expire old threats (> 60s)
    for (const [key, threat] of this.threats) {
      if (now - threat.timestamp > 60000) this.threats.delete(key);
    }
    // Expire old distress calls (> 120s)
    for (const [id, call] of this.distressCalls) {
      if (call.status !== 'active') continue;
      if (now - call.timestamp > 120000) {
        call.status = 'expired';
      }
    }
    // Expire old resource requests (> 180s)
    for (const [id, req] of this.resourceRequests) {
      if (req.status !== 'open') continue;
      if (now - req.timestamp > 180000) {
        req.status = 'expired';
      }
    }
    // Expire old food requests (> 120s)
    for (const [id, req] of this.foodRequests) {
      if (req.status !== 'open') continue;
      if (now - req.timestamp > 120000) {
        req.status = 'expired';
      }
    }
  }

  // --- Summary Metrics ---

  getSummary() {
    return {
      swarmId: this.swarmId,
      memberCount: this.members.size,
      shelter: this.shelter,
      chestsCount: this.chests.length,
      furnitureCount: this.furniture.length,
      farmsCount: this.farms.length,
      foodSourcesCount: this.foodSources.length,
      waypointsCount: this.waypoints.length,
      resourcesMapped: this.resources.size,
      activeThreats: this.threats.size,
      activeDistress: this.getActiveDistressCalls().length,
      activeRequests: this.getActiveResourceRequests().length,
      creatureEncountersCount: this.creatureEncounters.size,
      activeFoodRequests: this.getActiveFoodRequests().length,
      stats: { ...this.stats }
    };
  }
}

export const defaultSwarmBlackboard = new SwarmBlackboard();
export default defaultSwarmBlackboard;
