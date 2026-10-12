import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { SwarmBlackboard } from '../src/swarm/blackboard.js';
import { SwarmMessageBus } from '../src/swarm/message-bus.js';
import {
  SwarmRolePlanner,
  assignSwarmRoles,
  SWARM_ROLES
} from '../src/swarm/roles.js';
import { SwarmBot } from '../src/swarm/swarm-bot.js';
import { SwarmBotCognition } from '../src/swarm/cognition.js';
import { SwarmTrainingRunner } from '../src/swarm/train.js';
import { executeDropItem } from '../src/actions/drop.js';
import { executeAssistTeammate } from '../src/actions/assist.js';

test('SwarmBlackboard tracks members, shelters, chests, and resources', () => {
  const bb = new SwarmBlackboard();

  // 1. Members
  bb.updateMemberState('MIKA_Gatherer', {
    role: 'gatherer',
    position: { x: 10, y: 64, z: 20 },
    health: 20
  });
  bb.updateMemberState('MIKA_Guard', {
    role: 'guard',
    position: { x: 14, y: 64, z: 20 },
    health: 18
  });

  assert.strictEqual(bb.getAllMembers().length, 2);
  const member = bb.getMember('MIKA_Gatherer');
  assert.strictEqual(member.role, 'gatherer');

  // Nearest teammate
  const nearest = bb.getNearestTeammate({ x: 10, y: 64, z: 20 }, 'MIKA_Gatherer');
  assert.strictEqual(nearest.name, 'MIKA_Guard');
  assert.strictEqual(nearest.distance, 4);

  // 2. Shelter
  bb.registerShelter({ x: 0, y: 64, z: 0, builtBy: 'MIKA_Builder', isSafe: true });
  const shelter = bb.getShelter();
  assert.strictEqual(shelter.x, 0);
  assert.strictEqual(shelter.builtBy, 'MIKA_Builder');
  assert.strictEqual(bb.stats.sheltersBuilt, 1);

  // 3. Chest
  bb.registerChest({ x: 2, y: 64, z: 2, registeredBy: 'MIKA_Builder' });
  const chest = bb.getNearestChest({ x: 3, y: 64, z: 2 });
  assert.ok(chest);
  assert.strictEqual(chest.x, 2);

  // 4. Resources
  bb.registerResource({ type: 'oak_log', x: 20, y: 64, z: 30, discoveredBy: 'MIKA_Explorer' });
  const foundRes = bb.getNearestResource('oak_log', { x: 19, y: 64, z: 30 });
  assert.ok(foundRes);
  assert.strictEqual(foundRes.type, 'oak_log');
  bb.recordResourceCollected('oak_log', 3);
  assert.strictEqual(bb.stats.resourcesCollected['oak_log'], 3);
});

test('SwarmBlackboard manages distress calls and resource requests lifecycle', () => {
  const bb = new SwarmBlackboard();

  // 1. Distress Calls
  const call = bb.postDistressCall({
    botName: 'MIKA_Gatherer',
    position: { x: 50, y: 64, z: 50 },
    mobName: 'creeper',
    health: 6.0
  });
  assert.strictEqual(call.status, 'active');
  assert.strictEqual(bb.getActiveDistressCalls().length, 1);

  const claimed = bb.claimDistressCall(call.id, 'MIKA_Guard');
  assert.strictEqual(claimed.status, 'claimed');
  assert.strictEqual(claimed.handledBy, 'MIKA_Guard');
  assert.strictEqual(bb.getActiveDistressCalls().length, 0);

  const resolved = bb.resolveDistressCall(call.id, 'MIKA_Guard');
  assert.strictEqual(resolved.status, 'resolved');
  assert.strictEqual(bb.stats.rescuesPerformed, 1);
  assert.strictEqual(bb.stats.threatsDefeated, 1);

  // 2. Resource Requests
  const req = bb.postResourceRequest({
    botName: 'MIKA_Builder',
    resource: 'wood',
    count: 4,
    position: { x: 5, y: 64, z: 5 }
  });
  assert.strictEqual(req.status, 'open');
  assert.strictEqual(bb.getActiveResourceRequests().length, 1);

  const fulfilled = bb.fulfillResourceRequest(req.id, 'MIKA_Gatherer');
  assert.strictEqual(fulfilled.status, 'fulfilled');
  assert.strictEqual(fulfilled.fulfilledBy, 'MIKA_Gatherer');
  assert.strictEqual(bb.stats.itemsShared, 4);
});

test('SwarmMessageBus broadcasts and parses in-game chat messages', () => {
  const bus = new SwarmMessageBus();
  const received = [];

  bus.on('DISTRESS', (evt) => received.push(evt));

  // 1. Direct broadcast
  bus.broadcast('MIKA_Explorer', 'DISTRESS', { mob: 'zombie', health: 4, x: 10, y: 64, z: 10 });
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].sender, 'MIKA_Explorer');
  assert.strictEqual(received[0].payload.mob, 'zombie');

  // 2. Minecraft chat protocol parsing
  const chatMsg = '[SWARM:DISTRESS] {"mob":"skeleton","health":5,"x":12,"y":64,"z":14}';
  const parsed = bus.handleIncomingChat('MIKA_Builder', chatMsg);
  assert.ok(parsed);
  assert.strictEqual(parsed.type, 'DISTRESS');
  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[1].sender, 'MIKA_Builder');
  assert.strictEqual(received[1].payload.mob, 'skeleton');

  // Non-swarm chat is ignored
  const normalChat = bus.handleIncomingChat('Steve', 'Hello world!');
  assert.strictEqual(normalChat, null);
});

test('assignSwarmRoles scales up to 4 specialized roles', () => {
  assert.deepStrictEqual(assignSwarmRoles(1), [SWARM_ROLES.GATHERER]);
  assert.deepStrictEqual(assignSwarmRoles(2), [SWARM_ROLES.GATHERER, SWARM_ROLES.GUARD]);
  assert.deepStrictEqual(assignSwarmRoles(3), [SWARM_ROLES.GATHERER, SWARM_ROLES.BUILDER, SWARM_ROLES.GUARD]);
  assert.deepStrictEqual(assignSwarmRoles(4), [SWARM_ROLES.GATHERER, SWARM_ROLES.BUILDER, SWARM_ROLES.GUARD, SWARM_ROLES.EXPLORER]);
});

test('SwarmRolePlanner: Guard prioritizes distress call and rescues teammate', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard();
  const bus = new SwarmMessageBus();

  // Teammate Gatherer posts distress call
  bb.postDistressCall({
    botName: 'MIKA_Gatherer',
    position: { x: 30, y: 64, z: 30 },
    mobName: 'creeper',
    health: 6.0
  });

  const guardBot = { username: 'MIKA_Guard' };
  const guardObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, yaw: 0 },
    nearby_threats: [],
    inventory: [{ name: 'diamond_sword', count: 1 }, { name: 'shield', count: 1 }]
  };

  const action = planner.proposeAction({
    bot: guardBot,
    role: SWARM_ROLES.GUARD,
    observation: guardObs,
    blackboard: bb,
    messageBus: bus
  });

  assert.strictEqual(action.action, 'assist_teammate');
  assert.strictEqual(action.arguments.teammate, 'MIKA_Gatherer');
  assert.strictEqual(action.arguments.x, 30);
  assert.strictEqual(action.arguments.z, 30);
  assert.ok(action.reason_summary.includes('MIKA_Gatherer'));
});

test('SwarmRolePlanner: Guard attacks nearby hostile mob when no distress call', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard();
  const bus = new SwarmMessageBus();

  const guardBot = { username: 'MIKA_Guard' };
  const guardObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, yaw: 0 },
    nearby_threats: [{ name: 'zombie', distance: 4.2 }],
    inventory: [{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }]
  };

  const action = planner.proposeAction({
    bot: guardBot,
    role: SWARM_ROLES.GUARD,
    observation: guardObs,
    blackboard: bb,
    messageBus: bus
  });

  assert.strictEqual(action.action, 'attack_target');
  assert.strictEqual(action.arguments.mob, 'zombie');
});

test('SwarmRolePlanner: Gatherer fulfills resource request and drops items for teammate', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard();
  const bus = new SwarmMessageBus();

  // Teammate Builder is near and requested wood
  bb.updateMemberState('MIKA_Builder', {
    position: { x: 2, y: 64, z: 2 },
    isAlive: true
  });
  bb.postResourceRequest({
    botName: 'MIKA_Builder',
    resource: 'wood',
    count: 3,
    position: { x: 2, y: 64, z: 2 }
  });

  const gathererBot = { username: 'MIKA_Gatherer' };
  const gathererObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, yaw: 0 },
    inventory: [{ name: 'oak_wood', count: 5 }],
    nearby_threats: []
  };

  const action = planner.proposeAction({
    bot: gathererBot,
    role: SWARM_ROLES.GATHERER,
    observation: gathererObs,
    blackboard: bb,
    messageBus: bus
  });

  assert.strictEqual(action.action, 'drop_item');
  assert.strictEqual(action.arguments.item, 'oak_wood');
  assert.strictEqual(action.arguments.teammate, 'MIKA_Builder');
  assert.strictEqual(action.arguments.count, 3);
});

test('SwarmRolePlanner: Builder crafts shelter with blocks and registers it', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard();
  const bus = new SwarmMessageBus();

  const builderBot = { username: 'MIKA_Builder' };
  const builderObs = {
    agent: { position: { x: 10, y: 64, z: 10 }, health: 20, food: 20, yaw: 0 },
    inventory: [{ name: 'dirt', count: 12 }],
    nearby_threats: []
  };

  const action = planner.proposeAction({
    bot: builderBot,
    role: SWARM_ROLES.BUILDER,
    observation: builderObs,
    blackboard: bb,
    messageBus: bus
  });

  assert.strictEqual(action.action, 'place_block');
  assert.strictEqual(action.arguments.block, 'dirt');
  assert.ok(action.goal.includes('shelter'));
});

test('SwarmBot executes step, coordinates with blackboard, and logs experience', async () => {
  const bb = new SwarmBlackboard();
  const bus = new SwarmMessageBus();
  const recordedLogs = [];

  const mockBot = {
    username: 'MIKA_Gatherer',
    isReady: true,
    version: '1.21.11',
    entity: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
    collectObservation: () => ({
      agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, isAlive: true },
      inventory: [{ name: 'oak_log', count: 2 }],
      nearby_threats: [],
      environment: { isDay: true, dimension: 'overworld' }
    }),
    actions: {
      execute: async (plan) => ({
        execution: { status: 'success', duration_ms: 15 },
        outcome: { task_progress: 1, reward: 1.0 }
      })
    },
    recorder: {
      recordExperience: (rec) => recordedLogs.push(rec)
    },
    on: () => {}
  };

  const swarmBot = new SwarmBot(mockBot, {
    role: SWARM_ROLES.GATHERER,
    blackboard: bb,
    messageBus: bus
  });

  const stepResult = await swarmBot.runStep();
  assert.strictEqual(stepResult.step, 1);
  assert.strictEqual(stepResult.role, SWARM_ROLES.GATHERER);
  assert.strictEqual(stepResult.execution.status, 'success');

  // Verify blackboard updated
  const member = bb.getMember('MIKA_Gatherer');
  assert.ok(member);
  assert.strictEqual(member.role, SWARM_ROLES.GATHERER);

  // Verify recorded experience has swarm role
  assert.strictEqual(recordedLogs.length, 1);
  assert.strictEqual(recordedLogs[0].decision.swarm_role, SWARM_ROLES.GATHERER);
});

test('executeDropItem tosses item from inventory', async () => {
  let droppedCount = 0;
  const mockBot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [{ name: 'oak_log', count: 4, type: 17 }]
    },
    toss: async (type, meta, count) => {
      droppedCount = count;
    }
  };

  const res = await executeDropItem(mockBot, { item: 'oak_log', count: 2, teammate: 'MIKA_Builder' });
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.data.count, 2);
  assert.strictEqual(droppedCount, 2);

  // Missing item handling
  const failRes = await executeDropItem(mockBot, { item: 'diamond', count: 1 });
  assert.strictEqual(failRes.status, 'failed');
  assert.strictEqual(failRes.error_code, 'ITEM_NOT_IN_INVENTORY');
});

test('executeAssistTeammate navigates to ally and engages threat', async () => {
  let attackTarget = null;

  const mockBot = {
    entity: {
      position: {
        x: 18,
        y: 64,
        z: 20,
        distanceTo: (p) => Math.hypot(p.x - 18, p.z - 20)
      }
    },
    players: {
      MIKA_Gatherer: {
        entity: {
          position: {
            x: 20,
            y: 64,
            z: 20,
            distanceTo: (p) => Math.hypot(p.x - 20, p.z - 20)
          }
        }
      }
    },
    entities: {
      101: {
        name: 'creeper',
        position: {
          x: 20.5,
          y: 64,
          z: 20,
          distanceTo: (p) => Math.hypot(p.x - 20.5, p.z - 20)
        }
      }
    },
    lookAt: async () => {},
    attack: async () => { attackTarget = 'creeper'; }
  };

  const res = await executeAssistTeammate(mockBot, { teammate: 'MIKA_Gatherer' });
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.data.assisted_teammate, 'MIKA_Gatherer');
  assert.ok(res.data.threat_engaged);
  assert.strictEqual(res.data.threat_engaged.mob, 'creeper');
  assert.strictEqual(attackTarget, 'creeper');
});

test('SwarmTrainingRunner coordinates mock training episodes and generates report', async () => {
  const testReportDir = path.join('./data/test', 'swarm_reports');
  fs.mkdirSync(testReportDir, { recursive: true });

  const mockOrchestrator = {
    blackboard: new SwarmBlackboard(),
    runCooperativeSurvival: async (steps) => {
      mockOrchestrator.blackboard.stats.rescuesPerformed += 1;
      mockOrchestrator.blackboard.stats.itemsShared += 2;
    },
    stopAll: () => {}
  };

  const runner = new SwarmTrainingRunner({
    bots: 4,
    episodes: 2,
    steps: 3,
    preprocess: false,
    skipLlm: true
  });
  runner.reportPath = path.join(testReportDir, 'swarm_training_report.json');

  const report = await runner.runTraining(mockOrchestrator);

  assert.strictEqual(report.bots_count, 4);
  assert.strictEqual(report.completed_episodes, 2);
  assert.strictEqual(report.total_bot_steps, 24); // 2 episodes * 3 steps * 4 bots = 24
  assert.strictEqual(report.swarm_stats.rescuesPerformed, 2);
  assert.strictEqual(report.swarm_stats.itemsShared, 4);

  assert.ok(fs.existsSync(runner.reportPath));
  const savedData = JSON.parse(fs.readFileSync(runner.reportPath, 'utf-8'));
  assert.strictEqual(savedData.completed_episodes, 2);

  // Clean up test file
  if (fs.existsSync(runner.reportPath)) fs.unlinkSync(runner.reportPath);
});

test('SwarmBotCognition generates situational monologue, focus, and trade-off analysis for each role', () => {
  const bb = new SwarmBlackboard();
  bb.updateMemberState('MIKA_Builder', {
    role: 'builder',
    position: { x: 5, y: 64, z: 5 },
    health: 18,
    isAlive: true
  });

  const mockBot = { username: 'MIKA_Guard', entity: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } }, chat: () => {} };
  const cognition = new SwarmBotCognition({
    bot: mockBot,
    role: SWARM_ROLES.GUARD,
    blackboard: bb,
    autoChat: false
  });

  const obs = {
    agent: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
    nearby_threats: [{ name: 'spider', distance: 6 }],
    environment: { isDay: false }
  };

  const decision = {
    action: 'attack_target',
    arguments: { mob: 'spider' },
    goal: 'engage hostile spider',
    confidence: 0.95
  };

  const deliberation = cognition.deliberate({ observation: obs, decision, stepCount: 1 });

  assert.ok(deliberation);
  assert.strictEqual(deliberation.botName, 'MIKA_Guard');
  assert.strictEqual(deliberation.role, SWARM_ROLES.GUARD);
  assert.ok(deliberation.situation.includes('HP 20.0/20'));
  assert.ok(deliberation.situation.includes('spider at 6m'));
  assert.ok(deliberation.monologue.includes('spider'));
  assert.strictEqual(cognition.thoughtHistory.length, 1);
});

test('SwarmBotCognition detects action repetition and reflects on anti-stagnation', () => {
  const cognition = new SwarmBotCognition({
    bot: { username: 'MIKA_Builder' },
    role: SWARM_ROLES.BUILDER,
    autoChat: false
  });

  const decision = { action: 'place_block', arguments: { x: 10, y: 64, z: 10 }, goal: 'place wall block' };
  const obs = { agent: { health: 20, position: { x: 10, y: 64, z: 10 } } };

  // Repeat same action 4 times
  cognition.deliberate({ observation: obs, decision, stepCount: 1 });
  cognition.deliberate({ observation: obs, decision, stepCount: 2 });
  cognition.deliberate({ observation: obs, decision, stepCount: 3 });
  const fourth = cognition.deliberate({ observation: obs, decision, stepCount: 4 });

  assert.strictEqual(cognition.stuckCounter, 3);
  assert.ok(fourth.monologue.includes('attempted') || fourth.monologue.includes('re-evaluate'));
});

test('SwarmBotCognition parses and responds to in-game chat !think and !status commands', () => {
  let spokenChat = [];
  const mockBot = {
    username: 'MIKA_Builder',
    entity: { health: 19.5 },
    chat: (msg) => spokenChat.push(msg)
  };

  const bb = new SwarmBlackboard();
  bb.updateMemberState('MIKA_Builder', { role: 'builder', isAlive: true, position: { x: 0, y: 64, z: 0 } });

  const cognition = new SwarmBotCognition({
    bot: mockBot,
    role: SWARM_ROLES.BUILDER,
    blackboard: bb,
    autoChat: false
  });

  cognition.deliberate({
    observation: { agent: { health: 19.5, position: { x: 0, y: 64, z: 0 } } },
    decision: { action: 'place_block', goal: 'build safe shelter' }
  });

  // 1. !think
  const handledThink = cognition.handleChatCommand('Player1', '!think');
  assert.strictEqual(handledThink, true);

  // 2. !think builder
  const handledRole = cognition.handleChatCommand('Player1', '!think builder');
  assert.strictEqual(handledRole, true);

  // 3. !status
  const handledStatus = cognition.handleChatCommand('Player1', '!status');
  assert.strictEqual(handledStatus, true);
});

test('SwarmBot embeds cognitive thinking into runStep output and experience logs', async () => {
  let loggedExp = [];
  const mockBot = {
    username: 'MIKA_Gatherer',
    isReady: true,
    entity: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [] },
    collectObservation: () => ({
      agent: { health: 20, food: 20, position: { x: 0, y: 64, z: 0 } },
      inventory: [{ name: 'oak_log', count: 5 }],
      nearby_threats: []
    }),
    actions: {
      execute: async () => ({
        execution: { status: 'success', duration_ms: 10 },
        outcome: { task_progress: 1 }
      })
    },
    recorder: {
      recordExperience: (r) => loggedExp.push(r)
    },
    on: () => {}
  };

  const swarmBot = new SwarmBot(mockBot, {
    role: SWARM_ROLES.GATHERER,
    autoChat: false
  });

  const result = await swarmBot.runStep();
  assert.ok(result.thinking);
  assert.strictEqual(result.thinking.botName, 'MIKA_Gatherer');
  assert.ok(result.thinking.monologue);

  // Check experience record
  assert.strictEqual(loggedExp.length, 1);
  assert.ok(loggedExp[0].decision.thinking);
  assert.ok(loggedExp[0].decision.thinking.monologue);
  assert.strictEqual(loggedExp[0].decision.swarm_role, SWARM_ROLES.GATHERER);
});

test('SwarmBlackboard tracks furniture, waypoints, animal herds, and synchronizes memory', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });

  // 1. Furniture
  const furn = bb.registerFurniture({ type: 'crafting_table', x: 10, y: 65, z: 20, placedBy: 'MIKA_Builder' });
  assert.strictEqual(furn.type, 'crafting_table');
  assert.strictEqual(bb.stats.furniturePlaced, 1);
  const foundFurn = bb.getFurniture('crafting_table', { x: 11, z: 20 });
  assert.ok(foundFurn);
  assert.strictEqual(foundFurn.type, 'crafting_table');

  // 2. Waypoints (drawing map)
  const wp = bb.registerWaypoint({ name: 'Iron Ridge', type: 'resource_vein', x: 45, y: 70, z: -30, tags: ['iron'], markedBy: 'MIKA_Explorer' });
  assert.strictEqual(wp.name, 'Iron Ridge');
  assert.strictEqual(bb.stats.waypointsMarked, 1);
  const nearestWp = bb.getNearestWaypoint({ x: 40, z: -30 });
  assert.ok(nearestWp);
  assert.strictEqual(nearestWp.name, 'Iron Ridge');

  // 3. Animal Herds (hunting)
  const animal = bb.registerAnimalHerd({ type: 'cow', x: 25, y: 64, z: 15, spottedBy: 'MIKA_Explorer' });
  assert.strictEqual(animal.type, 'cow');
  const nearestAnimal = bb.getNearestAnimal({ x: 20, z: 15 });
  assert.ok(nearestAnimal);
  assert.strictEqual(nearestAnimal.type, 'cow');
});

test('SwarmRolePlanner: Guard proactively protects all teammates from danger and executes bodyguard escort', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  // Teammates Farmer and Builder
  bb.updateMemberState('MIKA_Farmer', { position: { x: 20, y: 64, z: 20 }, health: 12, isAlive: true, role: 'farmer' });
  bb.updateMemberState('MIKA_Builder', { position: { x: 0, y: 64, z: 0 }, health: 20, isAlive: true, role: 'builder' });

  // Threat detected near Farmer
  bb.registerThreat({ mob: 'zombie', x: 22, y: 64, z: 21, severity: 'high' });

  const guardBot = { username: 'MIKA_Guard' };
  const guardObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, yaw: 0 },
    nearby_threats: [],
    inventory: [{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }]
  };

  const action = planner.proposeAction({
    bot: guardBot,
    role: SWARM_ROLES.GUARD,
    observation: guardObs,
    blackboard: bb,
    messageBus: bus
  });

  // Guard intercepts threat near teammate
  assert.strictEqual(action.action, 'assist_teammate');
  assert.strictEqual(action.arguments.teammate, 'MIKA_Farmer');
  assert.ok(action.reason_summary.includes('MIKA_Farmer'));
});

test('SwarmRolePlanner: Builder constructs shelter and crafts essential furniture', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  // Shelter already built
  bb.registerShelter({ x: 0, y: 64, z: 0, isSafe: true });

  const builderBot = { username: 'MIKA_Builder' };
  const builderObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, yaw: 0 },
    inventory: [{ name: 'planks', count: 12 }, { name: 'crafting_table', count: 1 }],
    nearby_threats: []
  };

  const action = planner.proposeAction({
    bot: builderBot,
    role: SWARM_ROLES.BUILDER,
    observation: builderObs,
    blackboard: bb,
    messageBus: bus
  });

  // Places crafting table furniture
  assert.strictEqual(action.action, 'place_block');
  assert.strictEqual(action.arguments.item, 'crafting_table');
  assert.ok(action.goal.includes('furniture'));
});

test('SwarmRolePlanner: Explorer hunts wild animals and draws map', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  // Explorer detects nearby cow
  const explorerBot = {
    username: 'MIKA_Explorer',
    entities: {
      99: { name: 'cow', position: { x: 12, y: 64, z: 5 } }
    },
    entity: { position: { x: 10, y: 64, z: 5 } }
  };

  const explorerObs = {
    agent: { position: { x: 10, y: 64, z: 5 }, health: 20, food: 20 },
    nearby_threats: [],
    nearby_resources: []
  };

  const action = planner.proposeAction({
    bot: explorerBot,
    role: SWARM_ROLES.EXPLORER,
    observation: explorerObs,
    blackboard: bb,
    messageBus: bus
  });

  // Hunts cow for food rations
  assert.strictEqual(action.action, 'attack_target');
  assert.strictEqual(action.arguments.mob, 'cow');
  assert.ok(action.goal.includes('hunt'));
});

test('SwarmRolePlanner: Farmer cultivates crops and replants seeds', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  const farmerBot = { username: 'MIKA_Farmer' };
  const farmerObs = {
    agent: { position: { x: 10, y: 64, z: 10 }, health: 20, food: 20 },
    inventory: [{ name: 'wheat', count: 2 }],
    nearby_threats: []
  };

  const action = planner.proposeAction({
    bot: farmerBot,
    role: SWARM_ROLES.FARMER,
    observation: farmerObs,
    blackboard: bb,
    messageBus: bus
  });

  assert.strictEqual(action.action, 'farm_crop');
  assert.ok(action.goal.includes('farm crops'));
});

test('assignSwarmRoles scales up to 5 and 6 specialized roles including Miner and Craftsman', () => {
  const roles5 = assignSwarmRoles(5);
  assert.deepStrictEqual(roles5, [
    SWARM_ROLES.GATHERER,
    SWARM_ROLES.BUILDER,
    SWARM_ROLES.GUARD,
    SWARM_ROLES.EXPLORER,
    SWARM_ROLES.MINER
  ]);

  const roles6 = assignSwarmRoles(6);
  assert.deepStrictEqual(roles6, [
    SWARM_ROLES.GATHERER,
    SWARM_ROLES.BUILDER,
    SWARM_ROLES.GUARD,
    SWARM_ROLES.EXPLORER,
    SWARM_ROLES.MINER,
    SWARM_ROLES.CRAFTSMAN
  ]);
});

test('SwarmRolePlanner: Miner crafts pickaxe, mines ores, and deposits in mineral chest', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  const minerBot = { username: 'MIKA_Miner' };

  // Case 1: No pickaxe, has wood -> crafts pickaxe
  const noPickObs = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
    inventory: [{ name: 'oak_planks', count: 4 }],
    nearby_threats: [],
    nearby_resources: []
  };
  const craftAction = planner.proposeAction({
    bot: minerBot,
    role: SWARM_ROLES.MINER,
    observation: noPickObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(craftAction.action, 'craft_item');
  assert.strictEqual(craftAction.arguments.item, 'wooden_pickaxe');

  // Case 2: Has pickaxe and surplus minerals -> deposits into mineral chest
  bb.registerChest({ x: 2, y: 64, z: 2, category: 'minerals', registeredBy: 'MIKA_Builder' });
  const surplusMineralsObs = {
    agent: { position: { x: 2, y: 64, z: 3 }, health: 20, food: 20 },
    inventory: [
      { name: 'iron_pickaxe', count: 1 },
      { name: 'raw_iron', count: 4 },
      { name: 'coal', count: 3 }
    ],
    nearby_threats: [],
    nearby_resources: []
  };
  const storeAction = planner.proposeAction({
    bot: minerBot,
    role: SWARM_ROLES.MINER,
    observation: surplusMineralsObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(storeAction.action, 'store_in_chest');
  assert.strictEqual(storeAction.arguments.category, 'minerals');
  assert.ok(storeAction.reason_summary.includes('mineral'));

  // Case 3: Has pickaxe, mines registered iron vein
  bb.registerResource({ type: 'iron_ore', x: 10, y: 50, z: 10, discoveredBy: 'MIKA_Explorer' });
  const mineObs = {
    agent: { position: { x: 9, y: 50, z: 10 }, health: 20, food: 20 },
    inventory: [{ name: 'stone_pickaxe', count: 1 }],
    nearby_threats: [],
    nearby_resources: []
  };
  const mineAction = planner.proposeAction({
    bot: minerBot,
    role: SWARM_ROLES.MINER,
    observation: mineObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(mineAction.action, 'collect_resource');
  assert.strictEqual(mineAction.arguments.resource, 'iron_ore');
});

test('SwarmRolePlanner: Builder crafts shield, weapons, and armor at crafting table', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  // Register placed shelter and workbench
  bb.registerShelter({ x: 0, y: 64, z: 0, isSafe: true, builtBy: 'MIKA_Builder' });
  bb.registerFurniture({ type: 'crafting_table', x: 1, y: 64, z: 1, placedBy: 'MIKA_Builder' });
  bb.registerChest({ x: 0, y: 64, z: 1, category: 'general', registeredBy: 'MIKA_Builder' });
  bb.registerChest({ x: 1, y: 64, z: 1, category: 'minerals', registeredBy: 'MIKA_Builder' });
  bb.registerFurniture({ type: 'furnace', x: 2, y: 64, z: 0, placedBy: 'MIKA_Builder' });

  const builderBot = { username: 'MIKA_Builder' };

  // Case 1: Builder crafts Shield with 1 iron ingot + 6 planks
  const shieldObs = {
    agent: { position: { x: 1, y: 64, z: 1 }, health: 20, food: 20 },
    inventory: [
      { name: 'iron_ingot', count: 1 },
      { name: 'oak_planks', count: 6 }
    ],
    nearby_threats: []
  };
  const shieldAction = planner.proposeAction({
    bot: builderBot,
    role: SWARM_ROLES.BUILDER,
    observation: shieldObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(shieldAction.action, 'craft_item');
  assert.strictEqual(shieldAction.arguments.item, 'shield');
  assert.ok(shieldAction.goal.includes('shield'));

  // Case 2: Builder crafts Stone Sword with 2 cobblestone + 1 stick
  const swordObs = {
    agent: { position: { x: 1, y: 64, z: 1 }, health: 20, food: 20 },
    inventory: [
      { name: 'cobblestone', count: 3 },
      { name: 'stick', count: 2 },
      { name: 'shield', count: 1 } // already has shield
    ],
    nearby_threats: []
  };
  const swordAction = planner.proposeAction({
    bot: builderBot,
    role: SWARM_ROLES.BUILDER,
    observation: swordObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(swordAction.action, 'craft_item');
  assert.strictEqual(swordAction.arguments.item, 'stone_sword');
  assert.ok(swordAction.goal.includes('stone sword'));

  // Case 3: Builder crafts Iron Armor with 8 iron ingots
  const armorObs = {
    agent: { position: { x: 1, y: 64, z: 1 }, health: 20, food: 20 },
    inventory: [
      { name: 'iron_ingot', count: 8 },
      { name: 'shield', count: 1 },
      { name: 'stone_sword', count: 1 }
    ],
    nearby_threats: []
  };
  const armorAction = planner.proposeAction({
    bot: builderBot,
    role: SWARM_ROLES.BUILDER,
    observation: armorObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(armorAction.action, 'craft_item');
  assert.strictEqual(armorAction.arguments.item, 'iron_chestplate');
  assert.ok(armorAction.goal.includes('iron armor'));
});

test('SwarmRolePlanner: Farmer and Explorer deposit into separate categorized chests', () => {
  const planner = new SwarmRolePlanner();
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  // Register separate chests
  bb.registerChest({ x: 10, y: 64, z: 10, category: 'food', registeredBy: 'MIKA_Builder' });
  bb.registerChest({ x: 20, y: 64, z: 20, category: 'minerals', registeredBy: 'MIKA_Builder' });

  // 1. Farmer deposits into food chest
  const farmerBot = { username: 'MIKA_Farmer' };
  const farmerObs = {
    agent: { position: { x: 10, y: 64, z: 11 }, health: 20, food: 20 },
    inventory: [{ name: 'wheat', count: 6 }],
    nearby_threats: []
  };
  const farmAction = planner.proposeAction({
    bot: farmerBot,
    role: SWARM_ROLES.FARMER,
    observation: farmerObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(farmAction.action, 'store_in_chest');
  assert.strictEqual(farmAction.arguments.category, 'food');

  // 2. Explorer deposits hunted meat into food chest
  const explorerBot = { username: 'MIKA_Explorer' };
  const explorerFoodObs = {
    agent: { position: { x: 11, y: 64, z: 10 }, health: 20, food: 20 },
    inventory: [{ name: 'beef', count: 5 }],
    nearby_threats: [],
    nearby_resources: []
  };
  const expFoodAction = planner.proposeAction({
    bot: explorerBot,
    role: SWARM_ROLES.EXPLORER,
    observation: explorerFoodObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(expFoodAction.action, 'store_in_chest');
  assert.strictEqual(expFoodAction.arguments.category, 'food');

  // 3. Explorer deposits leather into armory/mineral chest
  const explorerArmoryObs = {
    agent: { position: { x: 20, y: 64, z: 21 }, health: 20, food: 20 },
    inventory: [{ name: 'leather', count: 4 }],
    nearby_threats: [],
    nearby_resources: []
  };
  const expArmoryAction = planner.proposeAction({
    bot: explorerBot,
    role: SWARM_ROLES.EXPLORER,
    observation: explorerArmoryObs,
    blackboard: bb,
    messageBus: bus
  });
  assert.strictEqual(expArmoryAction.action, 'store_in_chest');
  assert.strictEqual(expArmoryAction.arguments.category, 'armory');
});

test('SwarmBotCognition supports Miner and Builder weapon/shield deliberations', () => {
  const minerCognition = new SwarmBotCognition({
    role: SWARM_ROLES.MINER,
    bot: { username: 'MIKA_Miner' }
  });

  const minerThought = minerCognition.deliberate({
    observation: { agent: { health: 20, food: 20 } },
    decision: {
      action: 'collect_resource',
      arguments: { resource: 'iron_ore' },
      goal: 'mine iron_ore vein'
    }
  });

  assert.strictEqual(minerThought.role, 'miner');
  assert.ok(minerThought.monologue.includes('Subterranean mining active'));
  assert.ok(minerThought.chatSummary.includes('⛏️'));
  assert.ok(minerThought.chatSummary.includes('iron_ore'));

  const builderCognition = new SwarmBotCognition({
    role: SWARM_ROLES.BUILDER,
    bot: { username: 'MIKA_Builder' }
  });

  const builderThought = builderCognition.deliberate({
    observation: { agent: { health: 20, food: 20 } },
    decision: {
      action: 'craft_item',
      arguments: { item: 'shield', count: 1 },
      goal: 'learn and craft shield at workbench'
    }
  });

  assert.ok(builderThought.monologue.includes('Learning new recipe at crafting table'));
  assert.ok(builderThought.chatSummary.includes('shield'));
});



// ==========================================
// CREATURE KNOWLEDGE & FOOD SUPPLY CHAIN TESTS
// ==========================================

test('SwarmBlackboard: creature encounter tracking and food request lifecycle', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });

  // Record a creature encounter (sighting)
  const enc = bb.recordCreatureEncounter({
    creature: 'cow',
    x: 100, y: 64, z: 200,
    killed: false,
    reportedBy: 'MIKA_Explorer'
  });
  assert.equal(enc.creature, 'cow');
  assert.equal(enc.kills, 0);
  assert.deepStrictEqual(enc.lastPosition, { x: 100, y: 64, z: 200 });

  // Record same creature killed
  const enc2 = bb.recordCreatureEncounter({
    creature: 'cow',
    x: 105, y: 64, z: 205,
    killed: true,
    drops: ['raw_beef', 'leather'],
    reportedBy: 'MIKA_Explorer'
  });
  assert.equal(enc2.kills, 1);
  assert.ok(enc2.drops.has('raw_beef'));
  assert.ok(enc2.drops.has('leather'));
  assert.equal(enc2.locations.length, 2);

  // Query creature encounters
  const cowEnc = bb.getCreatureEncounter('cow');
  assert.ok(cowEnc);
  assert.equal(cowEnc.kills, 1);
  assert.equal(bb.getAllCreatureEncounters().length, 1);

  // Nearest creature sighting
  const nearest = bb.getNearestCreatureSighting('cow', { x: 100, z: 200 });
  assert.ok(nearest);
  assert.ok(nearest.distance < 10);

  // Unknown creature returns null
  assert.equal(bb.getCreatureEncounter('dragon'), null);
  assert.equal(bb.getNearestCreatureSighting('dragon', { x: 0, z: 0 }), null);

  // --- Food Request Lifecycle ---
  const req = bb.postFoodRequest({
    botName: 'MIKA_Miner',
    position: { x: 50, y: 64, z: 50 },
    urgency: 'critical'
  });
  assert.ok(req.id);
  assert.equal(req.status, 'open');
  assert.equal(req.urgency, 'critical');
  assert.equal(req.botName, 'MIKA_Miner');

  // Deduplication: same bot doesn't create duplicate
  const dup = bb.postFoodRequest({ botName: 'MIKA_Miner', position: { x: 50, y: 64, z: 50 } });
  assert.equal(dup.id, req.id);

  // Active requests
  assert.equal(bb.getActiveFoodRequests().length, 1);

  // Claim food request
  const claimed = bb.claimFoodRequest(req.id, 'MIKA_Farmer');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimedBy, 'MIKA_Farmer');

  // Active requests should be empty after claim
  assert.equal(bb.getActiveFoodRequests().length, 0);

  // Fulfill food request
  const fulfilled = bb.fulfillFoodRequest(req.id, 'MIKA_Farmer');
  assert.equal(fulfilled.status, 'fulfilled');

  // Summary includes new fields
  const summary = bb.getSummary();
  assert.equal(summary.creatureEncountersCount, 1);
  assert.equal(summary.activeFoodRequests, 0);
});

test('SwarmBlackboard: purgeStaleData expires old threats, requests, and food requests', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });

  // Register a threat with old timestamp
  bb.registerThreat({ mob: 'zombie', x: 10, y: 64, z: 10, reportedBy: 'MIKA_Guard' });
  const threatKey = 'zombie_10_10';
  // Artificially age the threat
  bb.threats.get(threatKey).timestamp = Date.now() - 70000; // > 60s

  // Register a food request with old timestamp
  const foodReq = bb.postFoodRequest({ botName: 'MIKA_Builder', position: { x: 20, y: 64, z: 20 } });
  bb.foodRequests.get(foodReq.id).timestamp = Date.now() - 130000; // > 120s

  // Register a resource request with old timestamp
  const resReq = bb.postResourceRequest({ botName: 'MIKA_Miner', resource: 'wood', count: 3 });
  bb.resourceRequests.get(resReq.id).timestamp = Date.now() - 200000; // > 180s

  // Before purge
  assert.equal(bb.getActiveThreats().length, 1);
  assert.equal(bb.getActiveFoodRequests().length, 1);
  assert.equal(bb.getActiveResourceRequests().length, 1);

  bb.purgeStaleData();

  // After purge
  assert.equal(bb.getActiveThreats().length, 0);
  assert.equal(bb.getActiveFoodRequests().length, 0);
  assert.equal(bb.getActiveResourceRequests().length, 0);
});

test('SwarmRolePlanner: hunger food supply chain — eat, chest, request', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();
  const planner = new SwarmRolePlanner();

  const baseBotObs = {
    agent: {
      position: { x: 50, y: 64, z: 50 },
      health: 20,
      food: 10, // Hungry!
      isAlive: true
    },
    nearby_threats: [],
    nearby_resources: [],
    environment: { isDay: true }
  };

  // Step 1: Bot has food → eats from inventory
  const withFood = {
    ...baseBotObs,
    inventory: [{ name: 'cooked_beef', count: 3 }]
  };
  const eatDecision = planner.proposeAction({
    bot: { username: 'MIKA_Miner', entities: {} },
    role: SWARM_ROLES.MINER,
    observation: withFood,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(eatDecision.action, 'eat_food');
  assert.ok(eatDecision.reason_summary.includes('inventory'));

  // Step 2: No food in inventory, food chest nearby → withdraw
  bb.registerChest({ x: 52, y: 64, z: 52, category: 'food', registeredBy: 'MIKA_Builder' });
  const noFoodNearChest = {
    ...baseBotObs,
    inventory: []
  };
  const chestDecision = planner.proposeAction({
    bot: { username: 'MIKA_Miner', entities: {} },
    role: SWARM_ROLES.MINER,
    observation: noFoodNearChest,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(chestDecision.action, 'withdraw_from_chest');
  assert.ok(chestDecision.goal.includes('withdraw food'));

  // Step 3: No food in inventory, food chest far away but within 24m → navigate to chest
  bb.chests = []; // Clear and re-register at walkable distance
  bb.registerChest({ x: 65, y: 64, z: 65, category: 'food', registeredBy: 'MIKA_Builder' });
  const farChestDecision = planner.proposeAction({
    bot: { username: 'MIKA_Miner', entities: {} },
    role: SWARM_ROLES.MINER,
    observation: noFoodNearChest,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(farChestDecision.action, 'navigate_to');
  assert.ok(farChestDecision.goal.includes('food chest'));

  // Step 4: No food, no nearby chest → posts food request
  bb.chests = []; // No chests
  bb.registerChest({ x: 500, y: 64, z: 500, category: 'food', registeredBy: 'MIKA_Builder' }); // Very far
  const requestDecision = planner.proposeAction({
    bot: { username: 'MIKA_Miner', entities: {} },
    role: SWARM_ROLES.MINER,
    observation: noFoodNearChest,
    blackboard: bb,
    messageBus: bus
  });
  // Food request should have been posted
  const foodReqs = bb.getActiveFoodRequests();
  assert.ok(foodReqs.length >= 1);
  assert.equal(foodReqs[0].botName, 'MIKA_Miner');
});

test('SwarmRolePlanner: Farmer responds to food requests by emergency harvesting or delivering', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();
  const planner = new SwarmRolePlanner();

  // Simulate a hungry teammate's food request
  bb.postFoodRequest({
    botName: 'MIKA_Guard',
    position: { x: 30, y: 64, z: 30 },
    urgency: 'critical'
  });

  // Farmer has NO food → emergency harvest
  const farmerNoFood = {
    agent: { position: { x: 20, y: 64, z: 20 }, health: 20, food: 20, isAlive: true },
    nearby_threats: [],
    nearby_resources: [],
    inventory: [],
    environment: { isDay: true }
  };
  const harvestDecision = planner.proposeAction({
    bot: { username: 'MIKA_Farmer', entities: {} },
    role: SWARM_ROLES.FARMER,
    observation: farmerNoFood,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(harvestDecision.action, 'farm_crop');
  assert.ok(harvestDecision.goal.includes('emergency farm harvest'));

  // Farmer HAS food → deliver to teammate
  const farmerWithFood = {
    ...farmerNoFood,
    inventory: [
      { name: 'wheat', count: 5 },
      { name: 'carrot', count: 3 }
    ]
  };
  const deliverDecision = planner.proposeAction({
    bot: { username: 'MIKA_Farmer', entities: {} },
    role: SWARM_ROLES.FARMER,
    observation: farmerWithFood,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(deliverDecision.action, 'navigate_to');
  assert.ok(deliverDecision.goal.includes('deliver farm food'));
});

test('SwarmRolePlanner: Explorer responds to food requests and hunts with creature awareness', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();
  const planner = new SwarmRolePlanner();

  // Simulate a hungry teammate's food request
  bb.postFoodRequest({
    botName: 'MIKA_Builder',
    position: { x: 40, y: 64, z: 40 },
    urgency: 'normal'
  });

  // Explorer has food → deliver
  const explorerWithFood = {
    agent: { position: { x: 50, y: 64, z: 50 }, health: 20, food: 20, isAlive: true },
    nearby_threats: [],
    nearby_resources: [],
    inventory: [{ name: 'cooked_beef', count: 4 }],
    environment: { isDay: true }
  };
  const deliverDecision = planner.proposeAction({
    bot: { username: 'MIKA_Explorer', entities: {} },
    role: SWARM_ROLES.EXPLORER,
    observation: explorerWithFood,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(deliverDecision.action, 'navigate_to');
  assert.ok(deliverDecision.goal.includes('deliver food'));

  // Explorer hunting records creature encounter
  bb.foodRequests.clear();
  const explorerHunting = {
    agent: { position: { x: 50, y: 64, z: 50 }, health: 20, food: 20, isAlive: true },
    nearby_threats: [],
    nearby_resources: [],
    inventory: [],
    environment: { isDay: true }
  };
  const mockBot = {
    username: 'MIKA_Explorer',
    entity: { position: { x: 50, y: 64, z: 50 } },
    entities: {
      '1': { name: 'cow', position: { x: 55, y: 64, z: 55 } },
      '2': { name: 'pig', position: { x: 60, y: 64, z: 60 } }
    }
  };
  const huntDecision = planner.proposeAction({
    bot: mockBot,
    role: SWARM_ROLES.EXPLORER,
    observation: explorerHunting,
    blackboard: bb,
    messageBus: bus
  });
  assert.equal(huntDecision.action, 'attack_target');
  assert.ok(['cow', 'pig'].includes(huntDecision.arguments.mob));

  // Creature encounter should be recorded on blackboard
  const cowEnc = bb.getCreatureEncounter('cow');
  assert.ok(cowEnc || bb.getCreatureEncounter('pig'));
});

test('SwarmRolePlanner: Guard records creature encounters when engaging hostiles', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();
  const planner = new SwarmRolePlanner();

  const guardObs = {
    agent: { position: { x: 30, y: 64, z: 30 }, health: 18, food: 20, isAlive: true },
    nearby_threats: [{ name: 'zombie', distance: 5, position: { x: 35, y: 64, z: 30 } }],
    nearby_resources: [],
    inventory: [{ name: 'iron_sword', count: 1 }],
    environment: { isDay: false }
  };

  const decision = planner.proposeAction({
    bot: { username: 'MIKA_Guard', entities: {} },
    role: SWARM_ROLES.GUARD,
    observation: guardObs,
    blackboard: bb,
    messageBus: bus
  });

  assert.equal(decision.action, 'attack_target');
  assert.equal(decision.arguments.mob, 'zombie');

  // Creature encounter logged
  const zombieEnc = bb.getCreatureEncounter('zombie');
  assert.ok(zombieEnc);
  assert.deepStrictEqual(zombieEnc.lastPosition, { x: 35, y: 64, z: 30 });
});

test('SwarmMessageBus: requestFood and alertCreatureKilled helpers', () => {
  const bus = new SwarmMessageBus();
  const events = [];
  bus.on('NEED_FOOD', e => events.push(e));
  bus.on('CREATURE_KILLED', e => events.push(e));

  const mockBot = {
    username: 'MIKA_Miner',
    entity: { position: { x: 10, y: 64, z: 10 } },
    chat: () => {}
  };

  bus.requestFood(mockBot, 'critical', { x: 10, y: 64, z: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'NEED_FOOD');
  assert.equal(events[0].payload.urgency, 'critical');

  bus.alertCreatureKilled(mockBot, 'cow', ['raw_beef', 'leather'], { x: 20, y: 64, z: 20 });
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'CREATURE_KILLED');
  assert.equal(events[1].payload.creature, 'cow');
  assert.deepStrictEqual(events[1].payload.drops, ['raw_beef', 'leather']);
});

test('SwarmBotCognition: food delivery and creature hunting monologues', () => {
  const bb = new SwarmBlackboard({ autoHydrate: false });
  const bus = new SwarmMessageBus();

  // Explorer delivering food
  const explorerCog = new SwarmBotCognition({
    bot: { username: 'MIKA_Explorer', chat: () => {} },
    role: SWARM_ROLES.EXPLORER,
    blackboard: bb,
    messageBus: bus,
    autoChat: false
  });

  const deliverThought = explorerCog.deliberate({
    observation: {
      agent: { position: { x: 50, y: 64, z: 50 }, health: 20, food: 20 },
      nearby_threats: [],
      inventory: [{ name: 'cooked_beef', count: 5 }]
    },
    decision: {
      action: 'navigate_to',
      arguments: { x: 30, y: 64, z: 30 },
      goal: 'deliver food to hungry MIKA_Miner'
    }
  });
  assert.ok(deliverThought.monologue.includes('starving') || deliverThought.monologue.includes('deliver'));
  assert.ok(deliverThought.chatSummary.includes('🍖'));

  // Explorer hunting with creature knowledge
  const huntThought = explorerCog.deliberate({
    observation: {
      agent: { position: { x: 50, y: 64, z: 50 }, health: 20, food: 20 },
      nearby_threats: [],
      inventory: []
    },
    decision: {
      action: 'attack_target',
      arguments: { mob: 'cow' },
      goal: 'hunt wild cow for food rations'
    }
  });
  assert.ok(huntThought.monologue.includes('cow'));

  // Farmer emergency harvest
  const farmerCog = new SwarmBotCognition({
    bot: { username: 'MIKA_Farmer', chat: () => {} },
    role: SWARM_ROLES.FARMER,
    blackboard: bb,
    messageBus: bus,
    autoChat: false
  });

  const emergencyThought = farmerCog.deliberate({
    observation: {
      agent: { position: { x: 20, y: 64, z: 20 }, health: 20, food: 20 },
      nearby_threats: [],
      inventory: []
    },
    decision: {
      action: 'farm_crop',
      arguments: { max_distance: 16 },
      goal: 'emergency farm harvest for hungry teammate'
    }
  });
  assert.ok(emergencyThought.monologue.includes('Emergency') || emergencyThought.monologue.includes('starving'));
  assert.ok(emergencyThought.chatSummary.includes('🚨'));
});
