import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder } = pathfinderPkg.default || pathfinderPkg;
import pvpPkg from 'mineflayer-pvp';
const pvp = pvpPkg.plugin || pvpPkg.default?.plugin || pvpPkg.default || pvpPkg;
import config from '../config/index.js';
import { collectObservation } from './observe.js';
import { ExperienceRecorder } from '../data/recorder.js';
import { ActionExecutor } from '../actions/index.js';
import { defaultPlanner } from '../planner/planner.js';
import { defaultMemoryStore } from '../learning/memory.js';
import { defaultRecoveryManager } from '../learning/recovery.js';
import { defaultEpisodeManager } from '../episodes/runner.js';
import { evaluateSurvivalDirectives } from '../planner/survival-rules.js';
import { defaultProgression } from '../progression/state-machine.js';
import { defaultShelterManager } from '../survival/shelter.js';
import { selectContextualGoal, getSurvivalStatusReport } from '../survival/priority.js';
import { evaluateGoalOutcome } from '../learning/evaluate.js';
import { executeSafeCraft } from '../survival/crafting.js';
import { defaultAutonomousController } from '../survival/autonomous.js';
import { MikaVisionEngine } from '../vision/index.js';
import { normalizeGoalId, GOAL_DEFINITIONS } from '../learning/goals.js';

/**
 * Creates and initializes a Mineflayer bot connection.
 * @param {Object} overrides - Optional configuration overrides (e.g., custom port).
 * @returns {import('mineflayer').Bot}
 */
export function createBotConnection(overrides = {}) {
  const botOptions = {
    host: overrides.host || config.minecraft.host,
    port: overrides.port !== undefined ? overrides.port : config.minecraft.port,
    username: overrides.username || config.minecraft.username,
    auth: overrides.auth || config.minecraft.auth,
    // If version is specified, pass it; otherwise Mineflayer auto-detects from the server ping
    ...(config.minecraft.version ? { version: config.minecraft.version } : {})
  };

  console.log(`[Minecraft] Connecting bot '${botOptions.username}' to ${botOptions.host}:${botOptions.port} (version: ${botOptions.version || 'auto-detect'})...`);

  const bot = mineflayer.createBot(botOptions);

  // Wrap bot.chat with a rate limiter queue to prevent Minecraft disconnect.spam kicks
  const rawChat = bot.chat?.bind(bot);
  const chatQueue = [];
  let isSendingChat = false;
  const processChatQueue = () => {
    if (chatQueue.length === 0) {
      isSendingChat = false;
      return;
    }
    isSendingChat = true;
    const msg = chatQueue.shift();
    try {
      if (rawChat) rawChat(msg);
    } catch (_) {}
    setTimeout(processChatQueue, 800);
  };
  bot.chat = (message) => {
    if (!message) return;
    if (chatQueue.length >= 4) {
      chatQueue.shift(); // Drop oldest message to avoid backlog
    }
    chatQueue.push(message);
    if (!isSendingChat) {
      processChatQueue();
    }
  };

  // Attach observation collector and experience recorder
  bot.collectObservation = collectObservation;
  bot.activeModelVersion = overrides.modelVersion || 'v1.3.0';
  bot.assignedGoal = overrides.goal ? (normalizeGoalId(overrides.goal) || overrides.goal) : null;
  bot.recorder = new ExperienceRecorder({
    runId: overrides.runId || `run-${Date.now()}`,
    modelVersion: bot.activeModelVersion
  });
  bot.lastEventId = null;

  // Load pathfinder plugin for navigation
  bot.loadPlugin(pathfinder);

  // Load PvP combat plugin
  if (typeof pvp === 'function') {
    bot.loadPlugin(pvp);
  }

  // Initialize Action Executor for deterministic actions
  bot.actions = new ActionExecutor(bot);

  // Initialize High Level Planner
  bot.planner = defaultPlanner;
  bot.isAutonomous = false;
  bot.lastOutcome = null;

  // Initialize Memory Store & Recovery Manager (Milestone E)
  bot.memoryStore = defaultMemoryStore;
  bot.recovery = defaultRecoveryManager;

  // Initialize Autonomous Episode Manager (Milestone F)
  bot.episodeManager = defaultEpisodeManager;

  // Initialize Progression State Machine (Farmer -> Warrior -> Adventurer -> Dragon Slayer)
  bot.progression = defaultProgression;
  bot.shelterManager = defaultShelterManager;
  bot.autonomousSurvival = defaultAutonomousController;
  bot.vision = new MikaVisionEngine();
  bot.lastKnownPosition = null;
  bot.lastKnownInventory = [];
  bot.lastAttacker = null;
  bot.pendingDeathReason = null;
  if (typeof bot.setMaxListeners === 'function') {
    bot.setMaxListeners(50);
  }

  /**
   * Runs a single plan-and-execute step using Qwen 3.5 9B.
   */
  bot.stepPlan = async function(goal = 'survive, gather desert resources, and explore') {
    if (!bot.isReady) return { error: 'Bot not ready' };
    const obs = bot.collectObservation(bot);
    const planResult = await bot.planner.planNextStep({
      observation: obs,
      goal,
      previousOutcome: bot.lastOutcome
    });

    const dec = planResult.decision;
    console.log(`[Autonomous Step] Goal: "${dec.goal}" | Action: ${dec.action} | Reason: "${dec.reason_summary}"`);
    bot.chat(`[Qwen] ${dec.action}: ${dec.reason_summary}`);

    const execResult = await bot.actions.execute({
      action: dec.action,
      args: dec.arguments,
      goal: dec.goal,
      expectedOutcome: dec.expected_outcome
    });

    bot.lastOutcome = execResult.outcome;

    // Record complete experience
    const postObs = typeof bot.collectObservation === 'function' ? bot.collectObservation(bot) : null;
    let recordedExp = null;
    if (bot.recorder) {
      recordedExp = bot.recorder.recordExperience({
        minecraft_version: bot.version,
        dimension: obs?.environment?.dimension || 'overworld',
        observation_before: obs,
        observation_after: postObs,
        goal: dec.goal,
        available_actions: planResult.availableActions || [],
        decision: dec,
        execution: execResult.execution,
        outcome: execResult.outcome,
        learning: {
          failure_detected: execResult.execution.status !== 'success',
          failure_category: execResult.execution.error_code || (execResult.execution.status !== 'success' ? 'execution_failure' : null),
          feedback_event_ids: [],
          correction_applied: false,
          correction_verified: null
        }
      });
      if (recordedExp && recordedExp.event_id) {
        bot.lastEventId = recordedExp.event_id;
      }
    }

    // Automatic Milestone E recovery if action failed
    if (execResult.execution.status !== 'success' && bot.recovery) {
      console.log(`[Autonomous Step] Action failed (${execResult.execution.error_code || 'error'}). Triggering recovery...`);
      const recoveryResult = await bot.recovery.attemptRecovery({
        bot,
        failedStep: {
          action: dec.action,
          args: dec.arguments,
          execution: execResult.execution,
          outcome: execResult.outcome,
          observationBefore: obs,
          eventId: bot.lastEventId
        },
        goal: dec.goal
      });
      if (recoveryResult.recovered) {
        bot.lastOutcome = recoveryResult.retryResult?.outcome || execResult.outcome;
      }
      return { planResult, execResult, recovery: recoveryResult };
    }

    return { planResult, execResult };
  };

  // Connection Lifecycle Events
  bot.on('login', () => {
    console.log(`[Minecraft] Logged in successfully as '${bot.username}'`);
  });

  bot.on('spawn', () => {
    const pos = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
    console.log(`[Minecraft] Bot spawned into world at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
    console.log(`[Minecraft] Health: ${bot.health}/20 | Food: ${bot.food}/20 | GameMode: ${bot.game.gameMode}`);
    console.log(`[Minecraft] Active Model: ${bot.activeModelVersion || 'v1.3.0'} | Goal: ${bot.assignedGoal || 'Autonomous Survival'}`);
    bot.isReady = true;

    // Announce active version and goal in Minecraft chat
    setTimeout(() => {
      if (typeof bot.chat === 'function') {
        const goalDesc = bot.assignedGoal ? `Goal: ${bot.assignedGoal}` : 'Autonomous Survival';
        bot.chat(`[MIKA ${bot.activeModelVersion || 'v1.3.0'}] Online & ready! Model: ${bot.activeModelVersion || 'v1.3.0'} | ${goalDesc}`);
      }
    }, 1000);

    // Automatically snapshot initial world state after 1.5 seconds (let chunks stabilize)
    setTimeout(() => {
      if (bot.isReady && bot.recorder && bot.collectObservation) {
        const obs = bot.collectObservation(bot);
        bot.recorder.recordExperience({
          minecraft_version: bot.version,
          dimension: obs.environment.dimension,
          observation_before: obs,
          goal: bot.assignedGoal || 'initial spawn observation',
          available_actions: ['observe', 'inspect_inventory', 'look_around']
        });
        console.log(`[Observation] Logged initial spawn observation (Step #${bot.recorder.step})`);
      }

      // Auto-resume autonomous survival loop if bot was previously autonomous (e.g. after respawn)
      if (bot.isReady && bot.isAutonomous && bot.autonomousSurvival && !bot.autonomousSurvival.isRunning) {
        console.log('[Auto-Survival] Resuming autonomous loop post-spawn...');
        bot.autonomousSurvival.start(bot, 1000, true);
      }
    }, 1500);
  });

  bot.on('move', () => {
    if (bot.entity && bot.entity.position) {
      bot.lastKnownPosition = {
        x: Math.round(bot.entity.position.x * 10) / 10,
        y: Math.round(bot.entity.position.y * 10) / 10,
        z: Math.round(bot.entity.position.z * 10) / 10
      };
    }
  });

  bot.on('health', () => {
    if (bot.health !== undefined && bot.isReady) {
      if (bot.health <= 6) {
        console.warn(`[Minecraft] Warning: Low health! (${bot.health.toFixed(1)}/20)`);
      }
      if (bot.inventory && typeof bot.inventory.items === 'function') {
        bot.lastKnownInventory = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
      }
    }
  });

  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity && bot.entities) {
      let nearestDist = Infinity;
      let nearestMob = null;
      for (const id in bot.entities) {
        const e = bot.entities[id];
        if (!e || e === bot.entity || !e.position || !bot.entity.position) continue;
        const dist = typeof bot.entity.position.distanceTo === 'function'
          ? bot.entity.position.distanceTo(e.position)
          : Math.hypot(bot.entity.position.x - e.position.x, bot.entity.position.z - e.position.z);
        if (dist < nearestDist && ['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'witch', 'slime', 'phantom', 'enderman', 'ender_dragon'].includes(e.name?.toLowerCase())) {
          nearestDist = dist;
          nearestMob = e.name;
        }
      }
      if (nearestMob && nearestDist <= 6.0) {
        bot.lastAttacker = nearestMob;
      }
    }
  });

  bot.on('messagestr', (msg) => {
    if (!msg || !bot.username) return;
    if (msg.includes(bot.username)) {
      const deathKeywords = [
        'slain by', 'shot by', 'blown up by', 'hit the ground', 'fell from', 'drowned',
        'burned', 'went up in flames', 'swim in lava', 'starved', 'suffocated', 'killed by',
        'pushed by', 'squashed', 'withered', 'died'
      ];
      if (deathKeywords.some(kw => msg.toLowerCase().includes(kw))) {
        console.log(`[Minecraft Server Death Message] "${msg}"`);
        bot.pendingDeathReason = msg;
        if (bot.memoryStore && typeof bot.memoryStore.updateLastDeathMessage === 'function') {
          let detectedKiller = null;
          const match = msg.match(/(?:by|from)\s+([A-Za-z0-9_]+)/i);
          if (match && match[1] && match[1] !== bot.username) {
            detectedKiller = match[1];
          }
          bot.memoryStore.updateLastDeathMessage(msg, detectedKiller);
        }
      }
    }
  });

  bot.on('death', () => {
    console.warn(`[Minecraft] Bot died! Waiting for respawn...`);
    const deathPos = bot.entity?.position ? {
      x: Math.round(bot.entity.position.x * 10) / 10,
      y: Math.round(bot.entity.position.y * 10) / 10,
      z: Math.round(bot.entity.position.z * 10) / 10
    } : (bot.lastKnownPosition || { x: 0, y: 0, z: 0 });

    const currentItems = (bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : [];
    const lostItems = (currentItems.length > 0 ? currentItems : (bot.lastKnownInventory || [])).map(i => ({
      name: i.name,
      count: i.count
    }));

    // Determine primary death reason
    let deathReason = bot.pendingDeathReason || null;
    let killer = bot.lastAttacker || null;

    if (!deathReason) {
      if (killer) {
        deathReason = `Slain by ${killer}`;
      } else if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 0) {
        deathReason = 'Drowned';
      } else if (bot.food !== undefined && bot.food <= 0) {
        deathReason = 'Starvation';
      } else {
        deathReason = 'Combat or environmental hazard';
      }
    }

    // Record in persistent memory store (including lost things location and death reason)
    if (bot.memoryStore && typeof bot.memoryStore.recordDeath === 'function') {
      bot.memoryStore.recordDeath({
        position: deathPos,
        dimension: bot.game?.dimension || 'overworld',
        reason: deathReason,
        deathMessage: bot.pendingDeathReason,
        killer,
        lostItems
      });
      console.log(`[Memory] Stored death event: "${deathReason}" at (${deathPos.x}, ${deathPos.y}, ${deathPos.z}) with ${lostItems.length} lost items`);
    }

    if (bot.progression && typeof bot.progression.recordDeath === 'function') {
      bot.progression.recordDeath();
    }

    if (typeof bot.chat === 'function') {
      bot.chat(`[Death] MIKA died at (${deathPos.x}, ${deathPos.y}, ${deathPos.z})! Reason: ${deathReason}. Lost items location remembered.`);
    }

    if (bot.recorder && bot.collectObservation) {
      const obs = bot.collectObservation(bot);
      bot.recorder.recordExperience({
        minecraft_version: bot.version,
        dimension: obs.environment ? obs.environment.dimension : 'overworld',
        observation_before: obs,
        goal: 'death event record',
        outcome: { task_progress: 0, reward: -1.0 },
        learning: {
          failure_detected: true,
          failure_category: 'threat_response',
          feedback_event_ids: [],
          correction_applied: false,
          correction_verified: null
        }
      });
      console.log(`[Observation] Logged death event to experiences.jsonl`);
    }

    // Reset transient attacker
    bot.lastAttacker = null;
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) {
      console.log(`[MIKA Chat] ${message}`);
      return;
    }
    console.log(`[Minecraft Chat] <${username}> ${message}`);

    // Simple remote control & action commands
    const trimmed = message.trim();
    if (trimmed === '!stop') {
      bot.isAutonomous = false;
      if (bot.autonomousSurvival) {
        bot.autonomousSurvival.stop(bot);
      }
      if (bot.actions && bot.actions.currentAction) {
        bot.actions.stop('User stopped action via chat');
        bot.chat('Action stopped. MIKA is now idle.');
      } else {
        bot.chat('MIKA is now idle.');
      }
    } else if (trimmed === '!quit' || trimmed === '!disconnect') {
      console.log(`[Minecraft] Received disconnect command from chat. Stopping...`);
      disconnectBot(bot, 'Remote chat command');
    } else if (trimmed === '!status') {
      const p = bot.entity.position;
      const obs = typeof bot.collectObservation === 'function' ? bot.collectObservation(bot) : null;
      const selected = obs ? selectContextualGoal(obs, bot.memoryStore) : null;
      bot.chat(`Pos: (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) | HP: ${bot.health}/20 | Food: ${bot.food}/20`);
      if (selected) {
        bot.chat(`[Survival Priority] Tier ${selected.tier}: ${selected.goalId} (${selected.reason})`);
      }
    } else if (trimmed === '!inv') {
      bot.actions.execute({ action: 'inspect_inventory', goal: 'inspect inventory' }).then(res => {
        if (res.execution.status === 'success') {
          const items = res.execution.data.items.map(i => `${i.name}x${i.count}`).join(', ');
          bot.chat(`Inventory: ${items || 'Empty'} (${res.execution.data.empty_slots} free slots)`);
        } else {
          bot.chat(`Failed to inspect inventory: ${res.execution.error}`);
        }
      });
    } else if (trimmed === '!look') {
      bot.actions.execute({ action: 'look_around', goal: 'look around' }).then(res => {
        bot.chat(`Look around: ${res.execution.status}`);
      });
    } else if (trimmed.startsWith('!goto')) {
      const parts = trimmed.split(/\s+/).slice(1);
      if (parts.length >= 2) {
        const x = parseFloat(parts[0]);
        const y = parts.length >= 3 ? parseFloat(parts[1]) : undefined;
        const z = parts.length >= 3 ? parseFloat(parts[2]) : parseFloat(parts[1]);
        bot.chat(`Navigating to (${x}, ${y !== undefined ? y : '~'}, ${z})...`);
        bot.actions.execute({
          action: 'navigate_to',
          args: { x, y, z },
          goal: `navigate to ${x},${z}`,
          expectedOutcome: 'bot position is near target coordinates'
        }).then(res => {
          bot.chat(`Navigation: ${res.execution.status} (${res.execution.duration_ms}ms)`);
        });
      } else {
        bot.chat('Usage: !goto <x> <z> OR !goto <x> <y> <z>');
      }
    } else if (trimmed === '!come') {
      const playerEntity = bot.players[username]?.entity;
      if (playerEntity) {
        const p = playerEntity.position;
        bot.chat(`Coming to ${username} at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})...`);
        bot.actions.execute({
          action: 'navigate_to',
          args: { x: p.x, y: p.y, z: p.z, range: 2.0 },
          goal: `navigate to player ${username}`,
          expectedOutcome: `reach player ${username}`
        }).then(res => {
          bot.chat(`Navigation to ${username}: ${res.execution.status}`);
        });
      } else {
        bot.chat(`Cannot see player ${username}! Make sure you are within render distance.`);
      }
    } else if (trimmed === '!vision' || trimmed === '!visualtree' || trimmed === '!vis') {
      bot.chat('[Vision V1.3] Scanning camera viewport for tree trunks...');
      bot.vision.executeVisualTreeHarvest(bot).then(res => {
        if (res.success) {
          bot.chat(`[Vision V1.3: SUCCESS] Harvested trunk (Delta: +${res.outcome.delta || 1} wood). Latency: ${res.inferenceLatencyMs}ms`);
        } else {
          bot.chat(`[Vision V1.3: FAILED] ${res.outcome?.reason || res.reason || 'Could not harvest tree'}`);
        }
      }).catch(err => {
        bot.chat(`[Vision Error] ${err.message}`);
      });
    } else if (trimmed === '!wood' || trimmed === '!tree') {
      bot.chat('Locating nearest tree and navigating to harvest wood logs...');
      bot.actions.execute({
        action: 'collect_resource',
        args: { resource: 'wood', count: 3 },
        goal: 'locate and harvest tree for wood logs',
        expectedOutcome: 'inventory contains wood logs'
      }).then(res => {
        bot.chat(`Wood collection: ${res.execution.status} (${res.execution.error || `${res.execution.data?.blocks_chopped || 0} logs chopped`})`);
      });
    } else if (trimmed.startsWith('!collect')) {
      const resource = trimmed.split(/\s+/)[1];
      if (resource) {
        bot.chat(`Attempting to collect '${resource}'...`);
        bot.actions.execute({
          action: 'collect_resource',
          args: { resource },
          goal: `collect resource ${resource}`,
          expectedOutcome: `inventory contains additional ${resource}`
        }).then(res => {
          bot.chat(`Collect ${resource}: ${res.execution.status} (${res.execution.error || 'Done!'})`);
        });
      } else {
        bot.chat('Usage: !collect <block_name> (e.g. !collect oak_log or !collect dirt)');
      }
    } else if (trimmed === '!eat') {
      bot.actions.execute({
        action: 'eat_food',
        goal: 'restore hunger/health',
        expectedOutcome: 'food level increases'
      }).then(res => {
        bot.chat(`Eat food: ${res.execution.status} (${res.execution.error || res.execution.data?.consumed_item})`);
      });
    } else if (trimmed === '!pickaxe' || (trimmed.toLowerCase().includes('craft') && (trimmed.toLowerCase().includes('pick') || trimmed.toLowerCase().includes('ptck')))) {
      bot.chat('Placing crafting table if needed and crafting wooden pickaxe...');
      bot.actions.execute({
        action: 'craft_item',
        args: { item: 'wooden_pickaxe', count: 1 },
        goal: 'craft wooden pickaxe using crafting table',
        expectedOutcome: 'inventory contains wooden_pickaxe'
      }).then(res => {
        bot.chat(`Craft wooden pickaxe: ${res.execution.status} (${res.execution.error || 'Crafted successfully!'})`);
      });
    } else if (trimmed.startsWith('!craft')) {
      const parts = trimmed.split(/\s+/).slice(1);
      const item = parts[0];
      const count = parts[1] ? parseInt(parts[1], 10) : 1;
      if (item) {
        bot.chat(`Crafting ${count}x ${item}...`);
        bot.actions.execute({
          action: 'craft_item',
          args: { item, count },
          goal: `craft ${item}`,
          expectedOutcome: `inventory contains ${item}`
        }).then(res => {
          bot.chat(`Craft ${item}: ${res.execution.status} (${res.execution.error || 'Crafted successfully!'})`);
        });
      } else {
        bot.chat('Usage: !craft <item_name> [count]');
      }
    } else if (trimmed === '!observe') {
      if (bot.recorder && bot.collectObservation) {
        const obs = bot.collectObservation(bot);
        const event = bot.recorder.recordExperience({
          minecraft_version: bot.version,
          dimension: obs.environment.dimension,
          observation_before: obs,
          goal: 'user-triggered observation',
          available_actions: ['observe', 'inspect_inventory', 'look_around']
        });
        const threatsCount = obs.nearby_threats.length;
        const resourcesCount = obs.nearby_resources.length;
        bot.chat(`Observation #${event.step} logged! Threats: ${threatsCount}, Resources: ${resourcesCount}, Items: ${obs.inventory.length}`);
        console.log(`[Observation] Logged experience step #${event.step} to ${bot.recorder.experiencesPath}`);
      }
    } else if (trimmed.startsWith('!good') || trimmed.startsWith('!bad')) {
      const isGood = trimmed.startsWith('!good');
      const feedbackText = trimmed.replace(/^!(good|bad)/, '').trim() || (isGood ? 'Good decision' : 'Bad decision');
      if (bot.recorder) {
        const fbEvent = bot.recorder.recordFeedback({
          event_type: 'user_feedback',
          related_event_id: bot.lastEventId || null,
          label: isGood ? 'positive' : 'negative',
          feedback_text: feedbackText
        });
        console.log(`[Feedback] Recorded user feedback event ${fbEvent.event_id} (Linked to ${bot.lastEventId})`);
      }
      if (bot.memoryStore && typeof bot.memoryStore.recordPlayerFeedback === 'function') {
        const lesson = bot.memoryStore.recordPlayerFeedback({
          goalId: bot.lastGoalId || null,
          isGood,
          message: feedbackText
        });
        console.log(`[Feedback] Stored memory lesson: confidence=${lesson.confidence}, status=${lesson.status}`);
      }
      bot.chat(`Feedback recorded: [${isGood ? 'POSITIVE' : 'NEGATIVE'}] "${feedbackText}"`);
    } else if (trimmed === '!memories') {
      if (bot.memoryStore) {
        const activeMemories = bot.memoryStore.memories.filter(m => m.status === 'active');
        if (activeMemories.length === 0) {
          bot.chat('Memory store is empty. No learned corrections yet.');
        } else {
          bot.chat(`Learned corrections (${activeMemories.length}):`);
          for (const m of activeMemories.slice(0, 3)) {
            bot.chat(`- [${m.situation_pattern}] -> ${m.validated_correction?.action} (Confidence: ${m.confidence})`);
          }
        }
      }
    } else if (trimmed === '!testfail') {
      bot.chat('Triggering safe controlled failure (crafting stick without ingredients)...');
      (async () => {
        const failExec = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'stick' },
          goal: 'test failure diagnosis and recovery',
          expectedOutcome: 'inventory contains stick'
        });

        if (failExec.execution.status !== 'success' && bot.recovery) {
          bot.chat(`Failure observed: ${failExec.execution.error}`);
          const rec = await bot.recovery.attemptRecovery({
            bot,
            failedStep: {
              action: 'craft_item',
              args: { item: 'stick' },
              execution: failExec.execution,
              outcome: failExec.outcome,
              observationBefore: failExec.preObservation,
              eventId: bot.lastEventId
            },
            goal: 'recover missing ingredients'
          });

          bot.chat(`Recovery result: ${rec.recovered ? 'SUCCESS' : 'COMPLETED'} (Memory saved: ${bot.memoryStore.memories.length} entries)`);
        }
      })();
    } else if (trimmed === '!threats') {
      if (bot.collectObservation) {
        const obs = bot.collectObservation(bot);
        if (obs.nearby_threats.length === 0) {
          bot.chat('No immediate hostile threats detected nearby.');
        } else {
          const list = obs.nearby_threats.map(t => `${t.name} (${t.distance}m)`).join(', ');
          bot.chat(`Threats nearby: ${list}`);
        }
      }
    } else if (trimmed === '!rules') {
      if (bot.collectObservation) {
        const obs = bot.collectObservation(bot);
        const evalRules = evaluateSurvivalDirectives(obs);
        bot.chat(`[Survival Directives] Phase: ${evalRules.time_of_day.phase} (Time: ${evalRules.time_of_day.ticks})`);
        bot.chat(`Supplies: ${evalRules.inventory_supplies.logs_count} logs, ${evalRules.inventory_supplies.food_count} food`);
        bot.chat(`Daylight Status: ${evalRules.time_of_day.warning}`);
        if (evalRules.active_directives.length > 0) {
          bot.chat(`Current Priority: ${evalRules.active_directives[0].directive}`);
        }
      }
    } else if (trimmed === '!shelter') {
      bot.chat('Assessing site and building emergency shelter enclosure...');
      (async () => {
        const buildRes = await defaultShelterManager.buildEmergencyShelter(bot);
        if (buildRes.status === 'success' || buildRes.status === 'partial') {
          const safe = buildRes.data?.is_safe ? 'SAFE' : 'PARTIAL';
          bot.chat(`Shelter built: [${safe}] Walls: ${buildRes.data?.wall_coverage}/4, Roof: ${buildRes.data?.has_roof ? 'YES' : 'NO'}`);
        } else {
          bot.chat(`Shelter failed: ${buildRes.error} (Code: ${buildRes.error_code})`);
        }
      })();
    } else if (trimmed.startsWith('!survive') || trimmed.startsWith('!auto')) {
      const parts = trimmed.split(/\s+/);
      const sub = parts[1]?.toLowerCase();
      if (sub === 'off' || sub === 'stop') {
        bot.isAutonomous = false;
        if (bot.autonomousSurvival) {
          bot.autonomousSurvival.stop(bot);
        }
      } else {
        const stepBudget = parseInt(sub, 10) || 30;
        bot.isAutonomous = true;
        if (bot.autonomousSurvival) {
          bot.autonomousSurvival.start(bot, stepBudget);
        }
      }
    } else if (trimmed.startsWith('!goal')) {
      const arg = trimmed.replace(/^!goal\s*/, '').trim();
      if (!arg || arg === 'status') {
        const cur = bot.assignedGoal || 'None (Autonomous Survival)';
        bot.chat(`[Active Goal] ${cur}`);
      } else if (arg === 'clear' || arg === 'reset' || arg === 'none' || arg === 'off') {
        bot.assignedGoal = null;
        bot.chat('[Goal Cleared] Resuming autonomous contextual priority.');
      } else if (arg === 'list') {
        bot.chat('Available goals: shelter, two_player_shelter, wood, pickaxe, stone, tools, sword, furnace, chest, shield, food');
      } else {
        const normalized = normalizeGoalId(arg);
        if (normalized) {
          bot.assignedGoal = normalized;
          bot.isAutonomous = true;
          if (bot.autonomousSurvival && !bot.autonomousSurvival.isRunning) {
            bot.autonomousSurvival.start(bot, 1000, true);
          }
          bot.chat(`[Goal Set] Assigned goal: ${normalized}. Planning and executing prerequisites...`);
        } else {
          bot.chat(`Unknown goal: "${arg}". Type "!goal list" to see options.`);
        }
      }
    } else if (trimmed.startsWith('!skill')) {
      const sub = trimmed.replace(/^!skill\s*/, '').trim().toLowerCase();
      (async () => {
        const { defaultTwoPlayerShelterSkill, defaultSkillManager } = await import('../skills/index.js');
        if (sub === 'shelter' || sub === 'twoplayer' || sub === '2p' || sub === 'build') {
          bot.chat('[Skill: Two-Player Shelter] Inspecting world, planning, and executing construction...');
          const result = await defaultTwoPlayerShelterSkill.adaptSkillToWorld(bot);
          if (result.isComplete) {
            defaultTwoPlayerShelterSkill.saveAsLearnedSkill(result);
            bot.chat('[Skill Success] Two-player shelter constructed, verified, and saved to memory!');
          } else {
            bot.chat(`[Skill Status] Result: ${result.status} (${result.reason || result.error || 'partial'})`);
          }
        } else if (sub === 'list') {
          const list = defaultSkillManager.listSkills().map(s => s.skill_id).join(', ') || 'build_secure_two_player_shelter';
          bot.chat(`[Learned Skills] ${list}`);
        } else {
          bot.chat('Type "!skill shelter" to build two-player shelter or "!skill list"');
        }
      })();
    } else if (trimmed === '!diagnose' || trimmed === '!problems') {
      (async () => {
        const { defaultProblemSolver } = await import('../diagnostics/index.js');
        const summary = defaultProblemSolver.getSummary();
        bot.chat(`[Diagnostics] Problems: ${summary.problemsDetected} | Resolved: ${summary.problemsResolved} (${summary.resolutionRate}) | Escalated: ${summary.escalatedCount}`);
      })();
    } else if (trimmed === '!stage') {
      const obs = bot.collectObservation(bot);
      const status = bot.progression.getStatusSummary(obs);
      bot.chat(`[Progression Stage] ${status.stage.toUpperCase()}: ${status.title}`);
      bot.chat(`Mobs Defeated: ${status.stats.mobs_killed_total} | Damage Dealt: ${status.stats.damage_dealt_total}`);
      if (status.prerequisites_checklist.length > 0) {
        const metCount = status.prerequisites_checklist.filter(p => p.met).length;
        bot.chat(`Unlock ${status.next_stage.toUpperCase()}: ${metCount}/${status.prerequisites_checklist.length} prerequisites met.`);
        for (const p of status.prerequisites_checklist) {
          bot.chat(`* [${p.met ? 'DONE' : 'PENDING'}] ${p.description}`);
        }
      }
    } else if (trimmed === '!advancestage') {
      const obs = bot.collectObservation(bot);
      const advRes = bot.progression.advanceStage(obs, bot);
      if (!advRes.success) {
        bot.chat(`Cannot advance: ${advRes.reason}`);
      }
    } else if (trimmed === '!equip') {
      bot.chat('Evaluating inventory and auto-equipping best gear...');
      bot.actions.execute({ action: 'equip_gear', goal: 'equip best armor, weapons and shield' }).then(res => {
        if (res.execution.status === 'success') {
          const eq = res.execution.data?.equipped || {};
          bot.chat(`Gear Equipped: Weapon: ${eq.weapon || 'none'}, Shield: ${eq.offhand || 'none'}, Armor: [${eq.helmet || '-'}, ${eq.chestplate || '-'}, ${eq.leggings || '-'}, ${eq.boots || '-'}]`);
        } else {
          bot.chat(`Failed to equip gear: ${res.execution.error}`);
        }
      });
    } else if (trimmed.startsWith('!fight')) {
      const targetMob = trimmed.split(/\s+/)[1];
      bot.chat(`Engaging combat target ${targetMob || 'nearest hostile'} with weapon cooldowns...`);
      bot.actions.execute({
        action: 'attack_target',
        args: { mob: targetMob },
        goal: `defeat ${targetMob || 'hostile mob'}`
      }).then(res => {
        bot.chat(`Combat result: ${res.execution.status} (${res.execution.error || 'strike delivered'})`);
      });
    } else if (trimmed === '!retreat') {
      bot.chat('Executing tactical retreat and safe recovery...');
      bot.actions.execute({ action: 'retreat_and_heal', goal: 'tactical retreat' }).then(res => {
        bot.chat(`Retreat result: ${res.execution.status}`);
      });
    } else if (trimmed === '!store') {
      bot.chat('Storing surplus resources in nearby chest...');
      bot.actions.execute({ action: 'store_in_chest', goal: 'store items in chest' }).then(res => {
        bot.chat(`Chest storage: ${res.execution.status} (${res.execution.data?.total_types_deposited || 0} item types stored)`);
      });
    } else if (trimmed === '!farm') {
      bot.chat('Scanning for mature crops to harvest and replant...');
      bot.actions.execute({ action: 'farm_crop', goal: 'harvest and replant crops' }).then(res => {
        bot.chat(`Farming result: ${res.execution.status} (${res.execution.data?.harvested_crop || res.execution.error})`);
      });
    } else if (trimmed.startsWith('!plan')) {
      const customGoal = trimmed.replace(/^!plan/, '').trim() || 'survive, gather desert resources, and explore';
      bot.chat(`Consulting Qwen 3.5 9B for goal: "${customGoal}"...`);
      bot.stepPlan(customGoal).then(res => {
        if (res.execResult) {
          bot.chat(`Executed ${res.planResult.decision.action}: ${res.execResult.execution.status} (Outcome met: ${res.execResult.outcome.predicted_outcome_met})`);
        } else {
          bot.chat(`Planning failed: ${res.error || 'Unknown error'}`);
        }
      }).catch(err => {
        bot.chat(`Planner error: ${err.message}`);
      });
    } else if (trimmed.startsWith('!episode')) {
      const parts = trimmed.split(/\s+/).slice(1);
      const taskArg = parts[0]?.toLowerCase() || 'gather';
      let taskType = 'gather_resource';
      let taskTarget = { resource: 'sand', count: 2 };
      let strategy = 'qwen';
      const maxSteps = 12;

      if (taskArg.includes('nav') || taskArg.includes('return')) {
        taskType = 'navigate_and_return';
        taskTarget = {};
      } else if (taskArg.includes('hazard') || taskArg.includes('threat') || taskArg.includes('avoid')) {
        taskType = 'hazard_avoidance';
        taskTarget = {};
      } else {
        taskType = 'gather_resource';
        const resource = parts[1] || 'sand';
        const count = parseInt(parts[2], 10) || 2;
        taskTarget = { resource, count };
      }

      if (parts.includes('baseline')) {
        strategy = 'baseline';
      }

      bot.chat(`Initiating episode: ${taskType} with strategy '${strategy}'...`);
      bot.episodeManager.runEpisode({
        bot,
        taskType,
        taskTarget,
        strategy,
        maxSteps
      }).then(ep => {
        bot.chat(`Episode finished: ${ep.completion_status} (${ep.termination_reason}) in ${ep.metrics.total_steps} steps`);
      }).catch(err => {
        bot.chat(`Episode error: ${err.message}`);
      });
    } else if (trimmed === '!where' || trimmed === '!locations') {
      if (bot.memoryStore && typeof bot.memoryStore.getKnownLocationsSummary === 'function') {
        const summary = bot.memoryStore.getKnownLocationsSummary();
        bot.chat('[MIKA Memory Locations]');
        if (summary.shelter_base) {
          bot.chat(`- Shelter Base: (${summary.shelter_base.position.x}, ${summary.shelter_base.position.y}, ${summary.shelter_base.position.z}) [${summary.shelter_base.name}]`);
        } else {
          bot.chat('- Shelter Base: None registered (use !setbase or build shelter)');
        }
        if (summary.food) {
          bot.chat(`- Food: (${summary.food.position.x}, ${summary.food.position.y}, ${summary.food.position.z}) [${summary.food.name}]`);
        } else {
          bot.chat('- Food: None registered (use !setfood)');
        }
        if (summary.farm) {
          bot.chat(`- Farm: (${summary.farm.position.x}, ${summary.farm.position.y}, ${summary.farm.position.z}) [${summary.farm.name}]`);
        } else {
          bot.chat('- Farm: None registered (use !setfarm or !farm)');
        }
        if (summary.lost_things) {
          const count = summary.lost_things.metadata?.lost_items?.length || 0;
          bot.chat(`- Lost Things: (${summary.lost_things.position.x}, ${summary.lost_things.position.y}, ${summary.lost_things.position.z}) [${count} items dropped]`);
        } else {
          bot.chat('- Lost Things: None (no active death drop)');
        }
        bot.chat(`Last Died Reason: ${summary.last_died_reason}`);
      }
    } else if (trimmed === '!death' || trimmed === '!lastdeath' || trimmed === '!died') {
      if (bot.memoryStore) {
        const lastDeath = bot.memoryStore.getLastDeathInfo();
        if (lastDeath) {
          const pos = lastDeath.position ? `(${lastDeath.position.x}, ${lastDeath.position.y}, ${lastDeath.position.z})` : 'unknown';
          const itemsCount = lastDeath.lost_items ? lastDeath.lost_items.length : 0;
          bot.chat(`Last Death: "${lastDeath.reason}" at ${pos}`);
          bot.chat(`Killer: ${lastDeath.killer || 'none/environment'} | Lost Items: ${itemsCount} items | Time: ${lastDeath.timestamp}`);
        } else {
          bot.chat('No death recorded in memory. MIKA has not died yet!');
        }
      }
    } else if (trimmed === '!recover' || trimmed === '!lostthings') {
      if (bot.memoryStore) {
        const lost = bot.memoryStore.getLostThingsLocation();
        if (lost) {
          bot.chat(`Navigating to lost things at (${lost.position.x}, ${lost.position.y}, ${lost.position.z}) to recover items...`);
          bot.actions.execute({
            action: 'navigate_to',
            args: { x: lost.position.x, y: lost.position.y, z: lost.position.z, range: 1.5 },
            goal: 'recover lost dropped items from death location',
            expectedOutcome: 'bot arrives at lost things location and collects items'
          }).then(res => {
            if (res.execution.status === 'success') {
              bot.chat('Reached lost things location! Items retrieved.');
              bot.memoryStore.clearLostThings();
            } else {
              bot.chat(`Could not reach lost things: ${res.execution.error}`);
            }
          });
        } else {
          bot.chat('No lost things location found in memory.');
        }
      }
    } else if (trimmed === '!base' || trimmed === '!shelterloc') {
      if (bot.memoryStore) {
        const base = bot.memoryStore.getLocation('shelter');
        if (base) {
          bot.chat(`Navigating to shelter base at (${base.position.x}, ${base.position.y}, ${base.position.z})...`);
          bot.actions.execute({
            action: 'navigate_to',
            args: { x: base.position.x, y: base.position.y, z: base.position.z, range: 2.0 },
            goal: 'navigate to shelter base',
            expectedOutcome: 'bot arrives at shelter base'
          }).then(res => {
            bot.chat(`Shelter navigation: ${res.execution.status}`);
          });
        } else {
          bot.chat('No shelter base location remembered yet. Use !setbase to mark current position.');
        }
      }
    } else if (trimmed === '!setbase') {
      if (bot.entity && bot.memoryStore) {
        const p = bot.entity.position;
        const saved = bot.memoryStore.recordLocation('shelter', p, { name: 'Main Shelter Base', set_by: username });
        bot.chat(`Set shelter base at (${saved.position.x}, ${saved.position.y}, ${saved.position.z})!`);
      }
    } else if (trimmed === '!foodloc') {
      if (bot.memoryStore) {
        const foodLoc = bot.memoryStore.getLocation('food');
        if (foodLoc) {
          bot.chat(`Navigating to food supply at (${foodLoc.position.x}, ${foodLoc.position.y}, ${foodLoc.position.z})...`);
          bot.actions.execute({
            action: 'navigate_to',
            args: { x: foodLoc.position.x, y: foodLoc.position.y, z: foodLoc.position.z, range: 2.0 },
            goal: 'navigate to food supply',
            expectedOutcome: 'bot arrives at food supply'
          }).then(res => {
            bot.chat(`Food navigation: ${res.execution.status}`);
          });
        } else {
          bot.chat('No food location remembered yet. Use !setfood to mark current position.');
        }
      }
    } else if (trimmed === '!setfood') {
      if (bot.entity && bot.memoryStore) {
        const p = bot.entity.position;
        const saved = bot.memoryStore.recordLocation('food', p, { name: 'Food Supply', set_by: username });
        bot.chat(`Set food location at (${saved.position.x}, ${saved.position.y}, ${saved.position.z})!`);
      }
    } else if (trimmed === '!farmloc') {
      if (bot.memoryStore) {
        const farmLoc = bot.memoryStore.getLocation('farm');
        if (farmLoc) {
          bot.chat(`Navigating to farm at (${farmLoc.position.x}, ${farmLoc.position.y}, ${farmLoc.position.z})...`);
          bot.actions.execute({
            action: 'navigate_to',
            args: { x: farmLoc.position.x, y: farmLoc.position.y, z: farmLoc.position.z, range: 2.0 },
            goal: 'navigate to crop farm',
            expectedOutcome: 'bot arrives at crop farm'
          }).then(res => {
            bot.chat(`Farm navigation: ${res.execution.status}`);
          });
        } else {
          bot.chat('No farm location remembered yet. Use !setfarm to mark current position.');
        }
      }
    } else if (trimmed === '!setfarm') {
      if (bot.entity && bot.memoryStore) {
        const p = bot.entity.position;
        const saved = bot.memoryStore.recordLocation('farm', p, { name: 'Crop Farm', set_by: username });
        bot.chat(`Set farm location at (${saved.position.x}, ${saved.position.y}, ${saved.position.z})!`);
      }
    } else if (trimmed === '!clearlost') {
      if (bot.memoryStore) {
        bot.memoryStore.clearLostThings();
        bot.chat('Cleared lost things location from memory.');
      }
    }
  });

  bot.on('kicked', (reason) => {
    let reasonText = reason;
    try {
      if (typeof reason === 'object') reasonText = JSON.stringify(reason);
    } catch (_) {}
    console.warn(`[Minecraft] Kicked from server. Reason: ${reasonText}`);
    bot.isReady = false;
  });

  bot.on('end', (reason) => {
    console.log(`[Minecraft] Bot disconnected from server. (${reason || 'Connection closed'})`);
    bot.isReady = false;
  });

  bot.on('error', (err) => {
    console.error(`[Minecraft] Connection error:`, err.message || err);
    if (err.code === 'ECONNREFUSED') {
      console.error(`[Minecraft] Connection refused on ${botOptions.host}:${botOptions.port}.`);
      console.error(`[Minecraft] Ensure your Minecraft world is running and 'Open to LAN' or server is active on this port.`);
    }
  });

  return bot;
}

/**
 * Cleanly disconnects the bot.
 * @param {import('mineflayer').Bot} bot 
 * @param {string} reason 
 */
export function disconnectBot(bot, reason = 'Normal shutdown') {
  if (!bot) return;
  console.log(`[Minecraft] Initiating clean disconnect: ${reason}`);
  try {
    bot.quit(reason);
  } catch (err) {
    console.warn(`[Minecraft] Error during quit:`, err.message);
  }
}

/**
 * Helper to wait for the bot to spawn with a timeout.
 * @param {import('mineflayer').Bot} bot 
 * @param {number} timeoutMs 
 * @returns {Promise<void>}
 */
export function waitForSpawn(bot, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (bot.isReady) return resolve();

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for bot spawn after ${timeoutMs}ms`));
    }, timeoutMs);

    function onSpawn() {
      cleanup();
      resolve();
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onEnd(reason) {
      cleanup();
      reject(new Error(`Connection ended before spawn: ${reason}`));
    }

    function cleanup() {
      clearTimeout(timer);
      bot.off('spawn', onSpawn);
      bot.off('error', onError);
      bot.off('end', onEnd);
    }

    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('end', onEnd);
  });
}
