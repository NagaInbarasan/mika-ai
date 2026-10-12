/**
 * Swarm Orchestrator.
 * Spawns, manages, and coordinates up to 4 collaborative MIKA bots simultaneously.
 * Handles staggered network connections, synchronized lifecycle events,
 * and graceful collective shutdown.
 */

import { createBotConnection, disconnectBot, waitForSpawn } from '../minecraft/connect.js';
import { SwarmBlackboard, defaultSwarmBlackboard } from './blackboard.js';
import { SwarmMessageBus, defaultSwarmMessageBus } from './message-bus.js';
import { SwarmBot } from './swarm-bot.js';
import { assignSwarmRoles, SWARM_ROLES } from './roles.js';

export const DEFAULT_BOT_NAMES = [
  'MIKA_Farmer',
  'MIKA_Builder',
  'MIKA_Guard',
  'MIKA_Explorer',
  'MIKA_Miner',
  'MIKA_Craftsman'
];

export class SwarmOrchestrator {
  constructor(options = {}) {
    this.botCount = Math.max(1, Math.min(6, options.botCount || 5));
    this.host = options.host || 'localhost';
    this.port = options.port !== undefined ? options.port : 25565;
    this.staggerMs = options.staggerMs !== undefined ? options.staggerMs : 1500;
    this.blackboard = options.blackboard || defaultSwarmBlackboard;
    this.messageBus = options.messageBus || defaultSwarmMessageBus;

    this.swarmBots = []; // Array of SwarmBot instances
    this.isRunning = false;
    this.stepIntervalMs = options.stepIntervalMs || 2500;
  }

  /**
   * Initializes and connects all bots in the swarm with staggered delays.
   * @param {Object} [overrides={}]
   * @returns {Promise<SwarmBot[]>}
   */
  async spawnSwarm(overrides = {}) {
    const total = Math.max(1, Math.min(6, overrides.botCount || this.botCount));
    const effectiveHost = overrides.host || this.host;
    const effectivePort = overrides.port !== undefined ? overrides.port : this.port;
    const customNames = overrides.names || DEFAULT_BOT_NAMES;
    const roles = assignSwarmRoles(total);

    console.log('====================================================');
    console.log(`  MIKA Swarm Orchestrator: Launching ${total} Bots   `);
    console.log('====================================================');
    console.log(`Target Server : ${effectiveHost}:${effectivePort}`);
    console.log(`Swarm Size    : ${total} bots (Max: 6)`);
    console.log(`Roles Assigned: ${roles.join(', ')}`);
    console.log('====================================================\n');

    this.swarmBots = [];
    this.blackboard.reset();

    for (let i = 0; i < total; i++) {
      const username = customNames[i] || `MIKA_${roles[i]}`;
      const role = roles[i];

      console.log(`[Swarm Orchestrator] Spawning bot #${i + 1}/${total}: '${username}' (Role: ${role.toUpperCase()})...`);

      let rawBot;
      try {
        rawBot = createBotConnection({
          host: effectiveHost,
          port: effectivePort,
          username,
          runId: `swarm-${Date.now()}-bot-${i + 1}`
        });
      } catch (connErr) {
        console.error(`[Swarm Orchestrator] Failed to connect bot '${username}':`, connErr.message);
        continue;
      }

      // Staggered join to avoid packet collision or kick
      if (i < total - 1 && this.staggerMs > 0) {
        await new Promise(r => setTimeout(r, this.staggerMs));
      }

      const swarmBot = new SwarmBot(rawBot, {
        role,
        blackboard: this.blackboard,
        messageBus: this.messageBus
      });

      this.swarmBots.push(swarmBot);
    }

    return this.swarmBots;
  }

  /**
   * Waits for all connected bots to complete their spawn event.
   * @param {number} [timeoutMs=35000]
   * @returns {Promise<boolean>}
   */
  async waitForAllSpawns(timeoutMs = 35000) {
    console.log(`[Swarm Orchestrator] Awaiting spawn events for ${this.swarmBots.length} bots...`);
    const spawnPromises = this.swarmBots.map(sb => waitForSpawn(sb.bot, timeoutMs));

    const results = await Promise.allSettled(spawnPromises);
    const spawnedCount = results.filter(r => r.status === 'fulfilled').length;

    console.log(`[Swarm Orchestrator] ${spawnedCount}/${this.swarmBots.length} bots successfully spawned into world!`);
    return spawnedCount === this.swarmBots.length;
  }

  /**
   * Runs the collaborative survival loop across all bots concurrently for a given number of cycles.
   * @param {number} [maxSteps=20]
   */
  async runCooperativeSurvival(maxSteps = 20) {
    this.isRunning = true;
    console.log(`\n[Swarm Orchestrator] Starting cooperative survival loop (${maxSteps} cycles across ${this.swarmBots.length} bots)...`);

    for (let cycle = 1; cycle <= maxSteps && this.isRunning; cycle++) {
      console.log(`\n=== [Swarm Co-op Cycle #${cycle}/${maxSteps}] ===`);

      // Execute one collaborative step on each ready bot in parallel
      const stepPromises = this.swarmBots.map(async (swarmBot) => {
        if (!swarmBot.bot.isReady) return null;
        try {
          return await swarmBot.runStep();
        } catch (stepErr) {
          console.warn(`[Swarm:${swarmBot.bot.username}] Step execution error:`, stepErr.message);
          return null;
        }
      });

      await Promise.allSettled(stepPromises);

      // Print live status report
      const summary = this.blackboard.getSummary();
      console.log(`[Swarm Live Telemetry] Cycle #${cycle}: Shelter: ${summary.shelter ? 'SAFE' : 'NONE'} | Rescues: ${summary.stats.rescuesPerformed} | Shared Items: ${summary.stats.itemsShared} | Mapped Res: ${summary.resourcesMapped}`);

      if (cycle < maxSteps && this.isRunning) {
        await new Promise(r => setTimeout(r, this.stepIntervalMs));
      }
    }

    this.isRunning = false;
    console.log(`\n[Swarm Orchestrator] Cooperative survival loop finished.`);
    this.printFinalReport();
  }

  /**
   * Prints full swarm performance summary.
   */
  printFinalReport() {
    const summary = this.blackboard.getSummary();
    console.log('\n====================================================');
    console.log('             SWARM PERFORMANCE REPORT               ');
    console.log('====================================================');
    console.log(`Active Bots           : ${this.swarmBots.length}`);
    console.log(`Shelter Established   : ${summary.shelter ? `Yes at (${summary.shelter.x}, ${summary.shelter.y}, ${summary.shelter.z})` : 'No'}`);
    console.log(`Teammates Rescued     : ${summary.stats.rescuesPerformed}`);
    console.log(`Resources Shared      : ${summary.stats.itemsShared}`);
    console.log(`Hostile Threats Fought: ${summary.stats.threatsDefeated}`);
    console.log(`Resources Harvested   :`, JSON.stringify(summary.stats.resourcesCollected));
    console.log('====================================================\n');
  }

  /**
   * Cleanly disconnects all bots in the swarm.
   * @param {string} [reason='Swarm shutdown']
   */
  stopAll(reason = 'Swarm shutdown') {
    this.isRunning = false;
    console.log(`[Swarm Orchestrator] Shutting down all ${this.swarmBots.length} bots: ${reason}`);
    for (const swarmBot of this.swarmBots) {
      if (swarmBot.bot) {
        disconnectBot(swarmBot.bot, reason);
      }
    }
  }
}

export const defaultSwarmOrchestrator = new SwarmOrchestrator();
export default defaultSwarmOrchestrator;
