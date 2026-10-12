/**
 * MIKA Swarm Cognitive Architecture.
 * Gives each bot in the swarm an explicit cognitive loop: situational awareness,
 * working memory, anti-stagnation reflection, first-person deliberation monologues,
 * and conversational expression in Minecraft chat and console.
 */

import { SWARM_ROLES } from './roles.js';

export class CognitiveDeliberation {
  constructor(options = {}) {
    this.id = `cog-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.timestamp = Date.now();
    this.botName = options.botName || 'MIKA_Bot';
    this.role = options.role || 'general';
    this.focus = options.focus || 'SURVIVAL';
    this.situation = options.situation || '';
    this.intent = options.intent || '';
    this.tradeoff = options.tradeoff || '';
    this.monologue = options.monologue || '';
    this.chatSummary = options.chatSummary || '';
    this.confidence = options.confidence !== undefined ? options.confidence : 1.0;
    this.action = options.action || 'idle';
  }
}

export class SwarmBotCognition {
  constructor(options = {}) {
    this.bot = options.bot;
    this.role = options.role || SWARM_ROLES.GATHERER;
    this.blackboard = options.blackboard;
    this.messageBus = options.messageBus;
    this.autoChat = options.autoChat !== undefined ? options.autoChat : true;
    this.chatIntervalSteps = options.chatIntervalSteps || 8; // announce thought every ~8 steps
    this.chatCooldownMs = options.chatCooldownMs || 12000; // 12s minimum between automatic chat monologues

    // Working memory
    this.thoughtHistory = [];
    this.recentActions = []; // { action, goal, status, timestamp }
    this.stuckCounter = 0;
    this.lastActionKey = null;
    this.lastChatBroadcastTime = 0;
    this.lastDeliberation = null;
    this.stepCounter = 0;
  }

  /**
   * Generates a structured cognitive thought deliberation based on current observation,
   * role responsibilities, blackboard team state, and planned decision.
   * @param {Object} context
   * @param {Object} context.observation
   * @param {Object} context.decision
   * @param {number} [context.stepCount=1]
   * @returns {CognitiveDeliberation}
   */
  deliberate({ observation, decision, stepCount = 1 }) {
    this.stepCounter = stepCount;
    const botName = this.bot?.username || `MIKA_${this.role}`;
    const agent = observation?.agent || { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } };
    const threats = observation?.nearby_threats || [];
    const env = observation?.environment || { isDay: true };
    const inv = observation?.inventory || [];

    // Track repetition for anti-stagnation reflection
    const currentActionKey = `${decision.action}:${JSON.stringify(decision.arguments || {})}`;
    if (this.lastActionKey === currentActionKey) {
      this.stuckCounter += 1;
    } else {
      this.stuckCounter = 0;
      this.lastActionKey = currentActionKey;
    }

    // 1. Situation Assessment
    const vitalsStr = `HP ${Number(agent.health).toFixed(1)}/20, Food ${agent.food || 20}/20`;
    const threatsStr = threats.length > 0
      ? `${threats.length} threat(s) nearby: ${threats.map(t => `${t.name} at ${t.distance || '?'}m`).join(', ')}`
      : 'Perimeter clear of hostiles';
    const dayNightStr = env.isDay ? 'Daylight (active foraging phase)' : 'Nightfall (dangerous nocturnal phase)';

    let nearestAlly = null;
    if (this.blackboard && agent.position) {
      nearestAlly = this.blackboard.getNearestTeammate(agent.position, botName);
    }
    const allyStr = nearestAlly
      ? `Nearest teammate ${nearestAlly.name} (${nearestAlly.role}) is ${nearestAlly.distance}m away`
      : 'No teammates in immediate proximity';

    const situation = `${vitalsStr} | ${threatsStr} | ${dayNightStr} | ${allyStr}`;

    // 2. Determine High-Level Cognitive Focus
    let focus = 'ROLE_DUTY';
    let intent = decision.goal || 'maintain survival';
    let tradeoff = 'Prioritizing primary role duty over secondary tasks.';

    if (agent.health <= 8.0 && threats.length > 0) {
      focus = 'EMERGENCY_DEFENSE';
      intent = 'Preserve bot life by evading lethal hostile mobs';
      tradeoff = 'Abandoning all secondary gathering to avoid death and gear loss.';
    } else if (decision.action === 'assist_teammate') {
      focus = 'TEAM_RESCUE';
      intent = `Intervene to save distressed teammate ${decision.arguments?.teammate || 'ally'}`;
      tradeoff = 'Diverting from local task because team survival is paramount.';
    } else if (decision.action === 'drop_item') {
      focus = 'RESOURCE_HANDOFF';
      intent = `Deliver essential supplies to teammate ${decision.arguments?.teammate || 'ally'}`;
      tradeoff = 'Transferring gathered resources to enable construction / crafting synergy.';
    } else if (decision.action === 'place_block' && decision.goal.includes('shelter')) {
      focus = 'SHELTER_CONSTRUCTION';
      intent = 'Erect fortified walls to protect the swarm before nightfall';
      tradeoff = 'Spending inventory blocks immediately for collective safety.';
    } else if (decision.action === 'collect_resource') {
      focus = 'MATERIAL_HARVEST';
      intent = `Harvest ${decision.arguments?.resource || 'materials'} for team reserves`;
      tradeoff = 'Investing physical effort into resource gathering.';
    } else if (decision.action === 'navigate_to') {
      focus = 'STRATEGIC_REPOSITION';
      intent = decision.goal;
      tradeoff = 'Relocating to optimal coordinates.';
    }

    // 3. Synthesize First-Person Internal Monologue
    const monologue = this._generateMonologue({
      botName,
      role: this.role,
      focus,
      situation,
      decision,
      agent,
      threats,
      inv,
      nearestAlly,
      env
    });

    // 4. Compact chat message for in-game display
    const chatSummary = this._generateChatSummary({
      role: this.role,
      focus,
      decision,
      threats,
      nearestAlly
    });

    const deliberation = new CognitiveDeliberation({
      botName,
      role: this.role,
      focus,
      situation,
      intent,
      tradeoff,
      monologue,
      chatSummary,
      confidence: decision.confidence || 0.9,
      action: decision.action
    });

    this.lastDeliberation = deliberation;
    this.thoughtHistory.push(deliberation);
    if (this.thoughtHistory.length > 20) {
      this.thoughtHistory.shift();
    }

    // Log to console with role-specific cognitive style
    this._logCognition(deliberation);

    // Broadcast to in-game chat if appropriate
    this._evaluateChatBroadcast(deliberation);

    return deliberation;
  }

  /**
   * Synthesizes natural-language internal monologue per role and situation.
   */
  _generateMonologue({ botName, role, focus, decision, agent, threats, inv, nearestAlly, env }) {
    // If the bot detects it is stuck or repeating
    if (this.stuckCounter >= 3) {
      return `I notice I've attempted '${decision.action}' ${this.stuckCounter} times without significant progress. I must re-evaluate my path and check for obstructions.`;
    }

    // Critical survival state
    if (focus === 'EMERGENCY_DEFENSE') {
      const mobName = threats[0]?.name || 'hostile mob';
      return `Danger! My health is down to ${Number(agent.health).toFixed(1)}/20 with a ${mobName} attacking. I'm executing an emergency tactical retreat toward safety!`;
    }

    // Assist teammate
    if (focus === 'TEAM_RESCUE') {
      return `Teammate ${decision.arguments?.teammate || 'an ally'} is in trouble! I am dropping current tasks and rushing in to provide combat assistance!`;
    }

    // Resource handoff
    if (focus === 'RESOURCE_HANDOFF') {
      return `Builder needs materials for our shelter. I have ${decision.arguments?.count || 1}x ${decision.arguments?.item || 'supplies'} ready; tossing them over now.`;
    }

    switch (role) {
      case SWARM_ROLES.FARMER:
      case SWARM_ROLES.GATHERER:
        if (decision.goal.includes('deliver farm food')) {
          return `Teammate needs food urgently! Loading up farm produce and rushing to deliver fresh rations.`;
        }
        if (decision.goal.includes('emergency farm harvest')) {
          return `Emergency harvest! A teammate is starving — prioritizing immediate crop collection to produce food.`;
        }
        if (decision.action === 'farm_crop') {
          return `Tending team farm: harvesting mature crops and replanting seeds to maintain a sustainable food supply.`;
        }
        if (decision.action === 'store_in_chest') {
          return `Depositing freshly harvested crops into the shared team storage chest for everyone to eat.`;
        }
        if (decision.action === 'collect_resource') {
          return `Harvesting ${decision.arguments?.resource || 'seeds and materials'} to expand our farm and supply team needs.`;
        }
        return `Surveying fertile soil and water sources to optimize crop growth and nourish the swarm.`;

      case SWARM_ROLES.BUILDER:
      case SWARM_ROLES.CRAFTSMAN:
        if (decision.goal.includes('shield')) {
          return `Learning new recipe at crafting table: assembling an iron ingot and wood planks to craft a combat shield for team defense.`;
        }
        if (decision.goal.includes('sword')) {
          return `Forging weapon at workbench using mined resources to equip our team guards.`;
        }
        if (decision.goal.includes('armor')) {
          return `Crafting protective armor plates at crafting table using mined iron for swarm defense.`;
        }
        if (decision.goal.includes('farm')) {
          return `Constructing organized farm plots near base to ensure continuous crop cultivation.`;
        }
        if (decision.goal.includes('furniture')) {
          return `Crafting and placing essential ${decision.arguments?.item || 'furniture'} inside our base shelter.`;
        }
        if (focus === 'SHELTER_CONSTRUCTION') {
          return `Constructing defensive shelter perimeter at base coordinates. We need a safe refuge before nocturnal mobs spawn.`;
        }
        if (decision.action === 'craft_item') {
          return `Crafting ${decision.arguments?.item || 'essential tools and furniture'} to upgrade team infrastructure.`;
        }
        if (decision.action === 'navigate_to' && decision.goal.includes('dropped')) {
          return `Collecting building supplies dropped on the ground by teammates to continue construction.`;
        }
        return `Inspecting blueprint layout. Assessing building blocks and leveling ground for our safe room.`;

      case SWARM_ROLES.MINER:
        if (decision.action === 'store_in_chest') {
          return `Depositing mined ores and minerals into dedicated mineral chest for Builder to craft weapons, shields, and armor.`;
        }
        if (decision.action === 'collect_resource') {
          return `Subterranean mining active: extracting ${decision.arguments?.resource || 'minerals'} to supply forge materials for weapons and armor.`;
        }
        if (decision.action === 'craft_item') {
          return `Crafting ${decision.arguments?.item || 'pickaxe'} at workbench to continue deep underground mining operations.`;
        }
        return `Prospecting terrain for iron, coal, and stone veins to fuel team armor and tool production.`;

      case SWARM_ROLES.GUARD:
        if (decision.action === 'attack_target') {
          const mob = decision.arguments?.mob || threats[0]?.name || 'hostile';
          return `Hostile ${mob} detected within security perimeter! Engaging to guard all teammates from danger.`;
        }
        if (decision.action === 'assist_teammate') {
          return `Guarding teammate ${decision.arguments?.teammate || 'an ally'} under threat! Intercepting mob before teammate takes damage.`;
        }
        if (decision.action === 'defend_with_shield') {
          return `Absorbing incoming attacks with my shield while positioning to protect teammates behind me.`;
        }
        if (decision.action === 'navigate_to') {
          return `Bodyguard patrol active: escorting working teammates to ensure everyone is protected from danger.`;
        }
        return `All teammates currently secure. Standing sentry watch and scanning horizon for hostile threats.`;

      case SWARM_ROLES.EXPLORER:
        if (decision.goal.includes('deliver food')) {
          return `Teammate is starving! Rushing to deliver food rations. No one goes hungry on my watch.`;
        }
        if (decision.action === 'attack_target') {
          const prey = decision.arguments?.mob || 'game';
          return `Tracking wild ${prey} — I've learned their behavior patterns. Clean melee strike to harvest meat for the team larder.`;
        }
        if (decision.action === 'collect_resource' && decision.arguments?.resource === 'sweet_berries') {
          return `Foraging wild sweet berries to supply team food rations.`;
        }
        if (decision.action === 'store_in_chest') {
          return `Delivering hunted food and crafting materials into designated storage chests.`;
        }
        if (decision.action === 'navigate_to' && decision.goal.includes('food chest')) {
          return `Heading to the food chest to deposit hunted meat for the hungry teammates.`;
        }
        if (decision.action === 'navigate_to') {
          return `Drawing terrain map, scouting uncharted sectors, and marking resource waypoints on shared team memory.`;
        }
        return `Reconnaissance ongoing: mapping surrounding terrain and surveying for animals and minerals.`;

      default:
        return `Evaluating environment and executing ${decision.action} to advance swarm objectives.`;
    }
  }

  /**
   * Generates a concise in-game chat line (under 80 chars for clean readability).
   */
  _generateChatSummary({ role, focus, decision, threats, nearestAlly }) {
    const roleEmoji = {
      [SWARM_ROLES.FARMER]: '🌾',
      [SWARM_ROLES.GATHERER]: '🌾',
      [SWARM_ROLES.BUILDER]: '🏠',
      [SWARM_ROLES.GUARD]: '⚔️',
      [SWARM_ROLES.EXPLORER]: '🧭',
      [SWARM_ROLES.MINER]: '⛏️',
      [SWARM_ROLES.CRAFTSMAN]: '🔨'
    }[role] || '💭';

    if (focus === 'EMERGENCY_DEFENSE') {
      return `${roleEmoji} Low HP! Retreating from ${threats[0]?.name || 'hostile'}!`;
    }
    if (focus === 'TEAM_RESCUE') {
      return `${roleEmoji} Guarding & rescuing ${decision.arguments?.teammate || 'ally'}!`;
    }
    if (focus === 'RESOURCE_HANDOFF') {
      return `${roleEmoji} Dropping ${decision.arguments?.count || 1}x ${decision.arguments?.item} for ${decision.arguments?.teammate}!`;
    }
    if (focus === 'SHELTER_CONSTRUCTION') {
      return `${roleEmoji} Building shelter safe room!`;
    }
    if (decision.goal.includes('shield')) {
      return `${roleEmoji} Learning recipe: Crafting shield at workbench!`;
    }
    if (decision.goal.includes('sword')) {
      return `${roleEmoji} Crafting sword weapon at workbench!`;
    }
    if (decision.goal.includes('armor')) {
      return `${roleEmoji} Crafting armor at workbench!`;
    }
    if (decision.goal.includes('furniture')) {
      return `${roleEmoji} Setting up ${decision.arguments?.item || 'furniture'} at base!`;
    }
    if (decision.goal.includes('deliver food') || decision.goal.includes('deliver farm food')) {
      return `${roleEmoji} 🍖 Delivering food to hungry teammate!`;
    }
    if (decision.goal.includes('withdraw food')) {
      return `${roleEmoji} 🍖 Withdrawing rations from food chest!`;
    }
    if (decision.goal.includes('food chest for rations')) {
      return `${roleEmoji} 🍖 Walking to food chest — hungry!`;
    }
    if (decision.goal.includes('emergency farm harvest')) {
      return `${roleEmoji} 🚨 Emergency harvest for starving teammate!`;
    }
    if (decision.goal.includes('farm')) {
      return `${roleEmoji} Establishing farm plot for food!`;
    }
    if (decision.action === 'farm_crop') {
      return `${roleEmoji} Harvesting mature crops & replanting seeds!`;
    }
    if (role === SWARM_ROLES.MINER && decision.action === 'collect_resource') {
      return `${roleEmoji} Mining ${decision.arguments?.resource || 'ores'} for forge!`;
    }
    if (role === SWARM_ROLES.MINER && decision.action === 'store_in_chest') {
      return `${roleEmoji} Storing mined minerals in mineral chest!`;
    }
    if (role === SWARM_ROLES.EXPLORER && decision.action === 'attack_target') {
      return `${roleEmoji} Hunting wild ${decision.arguments?.mob || 'game'} for food rations!`;
    }
    if (role === SWARM_ROLES.EXPLORER && decision.action === 'navigate_to') {
      return `${roleEmoji} Drawing map & marking frontier waypoints!`;
    }
    if (role === SWARM_ROLES.GUARD && threats.length > 0) {
      return `${roleEmoji} Engaging ${threats[0].name} to guard team!`;
    }

    return `${roleEmoji} ${decision.goal}`;
  }

  /**
   * Logs deliberation cleanly into terminal console.
   */
  _logCognition(deliberation) {
    const roleColors = {
      [SWARM_ROLES.FARMER]: 'FARMER',
      [SWARM_ROLES.GATHERER]: 'GATHERER',
      [SWARM_ROLES.BUILDER]: 'BUILDER',
      [SWARM_ROLES.GUARD]: 'GUARD',
      [SWARM_ROLES.EXPLORER]: 'EXPLORER',
      [SWARM_ROLES.MINER]: 'MINER',
      [SWARM_ROLES.CRAFTSMAN]: 'CRAFTSMAN'
    };
    const roleTag = roleColors[deliberation.role] || deliberation.role.toUpperCase();

    console.log(`[💭 Cognition:${roleTag}:${deliberation.botName}] 🎯 Focus: ${deliberation.focus} | "${deliberation.monologue}"`);
  }

  /**
   * Evaluates if this thought should be spoken in Minecraft chat.
   */
  _evaluateChatBroadcast(deliberation) {
    if (!this.autoChat || !this.bot || typeof this.bot.chat !== 'function') return;

    const now = Date.now();
    const timeSinceLastChat = now - this.lastChatBroadcastTime;
    const isMajorEvent = ['EMERGENCY_DEFENSE', 'TEAM_RESCUE', 'RESOURCE_HANDOFF'].includes(deliberation.focus);
    const isStepInterval = (this.stepCounter % this.chatIntervalSteps === 0);

    // Speak if cooldown passed AND (major event OR periodic cadence)
    if (timeSinceLastChat >= this.chatCooldownMs && (isMajorEvent || isStepInterval)) {
      this.lastChatBroadcastTime = now;
      this.expressThought(deliberation.chatSummary);
    }
  }

  /**
   * Speaks a thought into Minecraft chat with safe error handling.
   * @param {string} text
   */
  expressThought(text) {
    if (!this.bot || typeof this.bot.chat !== 'function') return;
    try {
      this.bot.chat(text);
    } catch (err) {
      console.warn(`[Cognition:${this.bot.username}] Chat error:`, err.message);
    }
  }

  /**
   * Handles player chat commands (e.g. `!think`, `!think guard`, `!team`, `!status`).
   * @param {string} username - sender username
   * @param {string} message - chat string
   * @returns {boolean} true if command was handled
   */
  handleChatCommand(username, message) {
    if (!message || !message.startsWith('!')) return false;

    const trimmed = message.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const target = parts[1] ? parts[1].toLowerCase() : null;

    const botName = this.bot?.username || `MIKA_${this.role}`;
    const myRole = this.role.toLowerCase();

    // 1. !think or !think <target>
    if (cmd === '!think' || cmd === '!thought' || cmd === '!deliberate') {
      const isTargeted = target && (target === botName.toLowerCase() || target === myRole || target === myRole.replace('mika_', ''));
      const isGeneral = !target;

      if (isTargeted || isGeneral) {
        const thought = this.lastDeliberation;
        if (thought) {
          const vitals = this.bot?.entity ? `HP: ${Number(this.bot.entity.health || 20).toFixed(1)}/20` : 'HP: 20';
          const reply = `💭 [${botName} (${this.role.toUpperCase()})]: ${vitals} | Focus: ${thought.focus} | "${thought.monologue}"`;
          // Stagger replies slightly if general to prevent chat message jamming
          const staggerDelay = isGeneral ? (['gatherer', 'builder', 'guard', 'explorer'].indexOf(myRole) * 350) : 0;
          setTimeout(() => this.expressThought(reply), Math.max(0, staggerDelay));
          return true;
        }
      }
    }

    // 2. !team or !status (handled by Builder or first available bot to avoid 4x spam)
    if ((cmd === '!team' || cmd === '!status' || cmd === '!swarm') && myRole === 'builder') {
      if (this.blackboard) {
        const summary = this.blackboard.getSummary();
        const shelterStatus = summary.shelter ? `Safe at (${summary.shelter.x}, ${summary.shelter.y}, ${summary.shelter.z})` : 'Under construction';
        const statusMsg = `📋 [Swarm Status] Active: ${summary.activeMembers} | Shelter: ${shelterStatus} | Rescues: ${summary.stats.rescuesPerformed} | Shared: ${summary.stats.itemsShared}`;
        setTimeout(() => this.expressThought(statusMsg), 200);
        return true;
      }
    }

    // 3. !help
    if (cmd === '!help' && myRole === 'builder') {
      this.expressThought('💡 MIKA Swarm Commands: !think, !think <guard|builder|gatherer|explorer>, !team, !status');
      return true;
    }

    return false;
  }

  /**
   * Returns current working memory state.
   */
  getWorkingMemory() {
    return {
      botName: this.bot?.username,
      role: this.role,
      stuckCounter: this.stuckCounter,
      recentThoughts: this.thoughtHistory.slice(-5),
      lastDeliberation: this.lastDeliberation
    };
  }
}

export default SwarmBotCognition;
