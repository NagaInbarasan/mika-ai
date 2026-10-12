/**
 * SwarmBot Agent Wrapper.
 * Embeds role-based collaborative intelligence, shared blackboard sync,
 * and inter-bot message bus coordination into a Mineflayer bot.
 */

import { defaultSwarmBlackboard } from './blackboard.js';
import { defaultSwarmMessageBus } from './message-bus.js';
import { defaultSwarmRolePlanner, SWARM_ROLES, ROLE_CONFIGS } from './roles.js';
import { SwarmBotCognition } from './cognition.js';

export class SwarmBot {
  constructor(bot, options = {}) {
    this.bot = bot;
    this.role = options.role || SWARM_ROLES.GATHERER;
    this.blackboard = options.blackboard || defaultSwarmBlackboard;
    this.messageBus = options.messageBus || defaultSwarmMessageBus;
    this.planner = options.planner || defaultSwarmRolePlanner;
    this.cognition = options.cognition || new SwarmBotCognition({
      bot: this.bot,
      role: this.role,
      blackboard: this.blackboard,
      messageBus: this.messageBus,
      autoChat: options.autoChat !== undefined ? options.autoChat : true
    });
    this.stepCount = 0;
    this.isAutonomous = false;
    this.currentGoal = null;
    this.roleConfig = ROLE_CONFIGS[this.role] || { title: this.role, primaryDuty: 'General survival' };

    this._setupListeners();
  }

  _setupListeners() {
    if (!this.bot) return;

    // Listen to chat for incoming swarm protocol messages and player commands
    if (typeof this.bot.on === 'function') {
      this.bot.on('chat', (username, message) => {
        if (username === this.bot.username) return;
        this.messageBus.handleIncomingChat(username, message);
        if (this.cognition) {
          this.cognition.handleChatCommand(username, message);
        }
      });
    }

    // React to message bus events
    this.messageBus.on('SHELTER_BUILT', (event) => {
      if (event.sender !== this.bot.username && this.blackboard) {
        this.blackboard.registerShelter({
          x: event.payload.x,
          y: event.payload.y,
          z: event.payload.z,
          isSafe: event.payload.isSafe,
          builtBy: event.sender
        });
        console.log(`[Swarm:${this.bot.username}] Noted shelter built by ${event.sender} at (${event.payload.x}, ${event.payload.y}, ${event.payload.z})`);
      }
    });

    this.messageBus.on('DISTRESS', (event) => {
      if (event.sender !== this.bot.username && this.blackboard) {
        this.blackboard.postDistressCall({
          botName: event.sender,
          position: { x: event.payload.x, y: event.payload.y, z: event.payload.z },
          mobName: event.payload.mob,
          health: event.payload.health
        });
        if (this.role === SWARM_ROLES.GUARD) {
          console.log(`[Swarm:GUARD:${this.bot.username}] Alert! Teammate ${event.sender} under attack by ${event.payload.mob}. Mobilizing!`);
        }
      }
    });

    this.messageBus.on('NEED_RESOURCE', (event) => {
      if (event.sender !== this.bot.username && this.blackboard) {
        this.blackboard.postResourceRequest({
          botName: event.sender,
          resource: event.payload.resource,
          count: event.payload.count,
          position: event.payload.position
        });
      }
    });

    this.messageBus.on('NEED_FOOD', (event) => {
      if (event.sender !== this.bot.username && this.blackboard) {
        if (typeof this.blackboard.postFoodRequest === 'function') {
          this.blackboard.postFoodRequest({
            botName: event.sender,
            position: event.payload.position,
            urgency: event.payload.urgency || 'normal'
          });
        }
      }
    });

    this.messageBus.on('CREATURE_KILLED', (event) => {
      if (this.blackboard && typeof this.blackboard.recordCreatureEncounter === 'function') {
        this.blackboard.recordCreatureEncounter({
          creature: event.payload.creature,
          x: event.payload.position?.x || 0,
          y: event.payload.position?.y || 64,
          z: event.payload.position?.z || 0,
          killed: true,
          drops: event.payload.drops || [],
          reportedBy: event.sender
        });
      }
    });
  }

  /**
   * Executes a single collaborative decision-and-action step.
   * @returns {Promise<Object>}
   */
  async runStep() {
    if (!this.bot || !this.bot.isReady || !this.bot.entity) {
      return { success: false, reason: 'Bot not ready' };
    }

    this.stepCount += 1;
    const preObs = typeof this.bot.collectObservation === 'function'
      ? this.bot.collectObservation(this.bot)
      : { agent: this.bot.entity, inventory: [] };

    // 1. Sync state to blackboard
    if (this.blackboard) {
      this.blackboard.updateMemberState(this.bot.username, {
        role: this.role,
        position: preObs.agent.position,
        health: preObs.agent.health,
        food: preObs.agent.food,
        currentTask: this.currentGoal || 'idle',
        isAlive: preObs.agent.isAlive !== false
      });
    }

    // 2. Propose collaborative, role-specialized action
    const decision = this.planner.proposeAction({
      bot: this.bot,
      role: this.role,
      observation: preObs,
      blackboard: this.blackboard,
      messageBus: this.messageBus
    });

    this.currentGoal = decision.goal;

    // 2.5 Deliberate structured cognitive thought
    let thought = null;
    if (this.cognition) {
      thought = this.cognition.deliberate({
        observation: preObs,
        decision,
        stepCount: this.stepCount
      });
      decision.thinking = {
        focus: thought.focus,
        situation: thought.situation,
        intent: thought.intent,
        tradeoff: thought.tradeoff,
        monologue: thought.monologue,
        chat_summary: thought.chatSummary
      };
    }

    console.log(`[Swarm:${this.role.toUpperCase()}:${this.bot.username}] Step #${this.stepCount}: ${decision.action} (${decision.reason_summary})`);

    // 3. Execute action
    let execResult = null;
    let outcome = null;

    if (this.bot.actions && typeof this.bot.actions.execute === 'function') {
      const res = await this.bot.actions.execute({
        action: decision.action,
        args: decision.arguments || {},
        goal: `[Swarm:${this.role}] ${decision.goal}`,
        expectedOutcome: decision.expected_outcome
      });
      execResult = res.execution;
      outcome = res.outcome;
    } else {
      execResult = { status: 'success', duration_ms: 10 };
      outcome = { task_progress: 1, reward: 1.0 };
    }

    // 4. Update blackboard on collaborative events
    if (execResult && execResult.status === 'success') {
      if (decision.action === 'place_block' && decision.goal.includes('shelter') && this.blackboard) {
        this.blackboard.registerShelter({
          x: preObs.agent.position.x,
          y: preObs.agent.position.y,
          z: preObs.agent.position.z,
          isSafe: true,
          builtBy: this.bot.username
        });
        this.messageBus.alertShelterBuilt(this.bot, preObs.agent.position);
      } else if (decision.action === 'place_block' && decision.goal.includes('furniture') && this.blackboard) {
        this.blackboard.registerFurniture({
          type: decision.arguments?.item || decision.arguments?.block || 'crafting_table',
          x: preObs.agent.position.x,
          y: preObs.agent.position.y,
          z: preObs.agent.position.z,
          placedBy: this.bot.username
        });
      } else if (decision.action === 'farm_crop' && this.blackboard) {
        this.blackboard.stats.farmsHarvested = (this.blackboard.stats.farmsHarvested || 0) + 1;
      } else if (decision.action === 'attack_target' && this.blackboard) {
        const mobName = decision.arguments?.mob || 'unknown';
        // Record creature kill encounter for team learning
        if (typeof this.blackboard.recordCreatureEncounter === 'function') {
          this.blackboard.recordCreatureEncounter({
            creature: mobName,
            x: preObs.agent.position.x,
            y: preObs.agent.position.y,
            z: preObs.agent.position.z,
            killed: true,
            reportedBy: this.bot.username
          });
        }
        if (decision.goal.includes('hunt')) {
          this.blackboard.stats.animalsHunted = (this.blackboard.stats.animalsHunted || 0) + 1;
          // Broadcast creature kill for team knowledge
          if (this.messageBus) {
            this.messageBus.alertCreatureKilled(this.bot, mobName, [], preObs.agent.position);
          }
        }
      } else if (decision.action === 'assist_teammate' && this.blackboard) {
        this.blackboard.stats.rescuesPerformed += 1;
      } else if (decision.action === 'drop_item' && this.blackboard) {
        this.blackboard.stats.itemsShared += (decision.arguments.count || 1);
        // If we just dropped food for a teammate, check and fulfill food requests
        if (this.blackboard && typeof this.blackboard.getActiveFoodRequests === 'function') {
          const foodReqs = this.blackboard.getActiveFoodRequests();
          const myReq = foodReqs.find(r => r.claimedBy === this.bot.username);
          if (myReq) {
            this.blackboard.fulfillFoodRequest(myReq.id, this.bot.username);
          }
        }
      } else if (decision.action === 'collect_resource' && this.blackboard) {
        this.blackboard.recordResourceCollected(decision.arguments.resource, decision.arguments.count || 1);
      }
    }

    // 4.5 Purge stale blackboard data periodically (every 50 steps)
    if (this.blackboard && this.stepCount % 50 === 0 && typeof this.blackboard.purgeStaleData === 'function') {
      this.blackboard.purgeStaleData();
    }

    // 5. Log experience with Swarm metadata and cognitive thinking
    if (this.bot.recorder && typeof this.bot.recorder.recordExperience === 'function') {
      const postObs = typeof this.bot.collectObservation === 'function'
        ? this.bot.collectObservation(this.bot)
        : preObs;

      this.bot.recorder.recordExperience({
        minecraft_version: this.bot.version || '1.21',
        dimension: preObs.environment ? preObs.environment.dimension : 'overworld',
        observation_before: preObs,
        goal: `[Swarm:${this.role}] ${decision.goal}`,
        decision: {
          action: decision.action,
          arguments: decision.arguments,
          reason_summary: decision.reason_summary,
          expected_outcome: decision.expected_outcome,
          risk: decision.risk || 'low',
          confidence: decision.confidence || 1.0,
          swarm_role: this.role,
          thinking: decision.thinking || null
        },
        execution: execResult,
        observation_after: postObs,
        outcome
      });
    }

    return {
      step: this.stepCount,
      role: this.role,
      decision,
      thinking: thought,
      execution: execResult,
      outcome
    };
  }

  /**
   * Retrieves the latest cognitive deliberation.
   * @returns {import('./cognition.js').CognitiveDeliberation|null}
   */
  getThinking() {
    return this.cognition ? this.cognition.lastDeliberation : null;
  }

  /**
   * Speaks a thought or message directly into Minecraft chat.
   * @param {string} text
   */
  expressThought(text) {
    if (this.cognition) {
      this.cognition.expressThought(text);
    }
  }
}

export default SwarmBot;
