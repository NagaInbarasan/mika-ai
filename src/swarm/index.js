/**
 * Swarm Entry Point CLI.
 * Runs up to 4 collaborative MIKA bots in a shared Minecraft world.
 *
 * Usage:
 *   node src/swarm/index.js --port 54321 --bots 4
 */

import config from '../config/index.js';
import { SwarmOrchestrator } from './orchestrator.js';

function parseSwarmArgs() {
  const args = process.argv.slice(2);
  const options = {
    bots: 5,
    port: config.minecraft.port,
    host: config.minecraft.host,
    steps: 50
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bots' && args[i + 1]) {
      options.bots = Math.max(1, Math.min(6, parseInt(args[i + 1], 10)));
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === '--steps' && args[i + 1]) {
      options.steps = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return options;
}

async function main() {
  const opts = parseSwarmArgs();

  console.log('====================================================');
  console.log('   MIKA MULTI-AGENT SWARM COLLABORATIVE SYSTEM      ');
  console.log('====================================================');
  console.log(`Minecraft Target : ${opts.host}:${opts.port}`);
  console.log(`Swarm Size       : ${opts.bots} bots (Max: 6)`);
  console.log(`Mode             : Collaborative Survival (No LLM Bottleneck)`);
  console.log('====================================================\n');

  const orchestrator = new SwarmOrchestrator({
    botCount: opts.bots,
    host: opts.host,
    port: opts.port
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const handleShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[System] Received ${signal}. Disconnecting all swarm bots cleanly...`);
    orchestrator.stopAll(signal);
    setTimeout(() => {
      console.log('[System] Swarm shutdown complete. Goodbye!');
      process.exit(0);
    }, 1200);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    await orchestrator.spawnSwarm({
      botCount: opts.bots,
      host: opts.host,
      port: opts.port
    });

    console.log('\n[Init] Waiting for all bots to spawn into world...');
    const allSpawned = await orchestrator.waitForAllSpawns(35000);

    if (allSpawned) {
      console.log('\n[SUCCESS] All swarm bots successfully connected and spawned!');
      console.log('[Info] Bots are now collaborating: sharing resources, defending against mobs, and building shelter.');
      console.log('[Info] Press Ctrl+C in this terminal to disconnect all bots cleanly.\n');

      // Console interactive input
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed === '!status' || trimmed === '!team') {
          orchestrator.printFinalReport();
        } else if (trimmed.startsWith('!think')) {
          const parts = trimmed.split(/\s+/);
          const target = parts[1] ? parts[1].toLowerCase() : null;
          console.log('\n====================================================');
          console.log('             SWARM COGNITIVE MONOLOGUES             ');
          console.log('====================================================');
          for (const sb of orchestrator.swarmBots) {
            if (!target || sb.bot.username?.toLowerCase().includes(target) || sb.role.toLowerCase() === target) {
              const th = sb.getThinking();
              if (th) {
                console.log(`[💭 ${sb.bot.username} (${sb.role.toUpperCase()})]`);
                console.log(`  Focus    : ${th.focus}`);
                console.log(`  Situation: ${th.situation}`);
                console.log(`  Intent   : ${th.intent}`);
                console.log(`  Thought  : "${th.monologue}"`);
                console.log(`  Action   : ${th.action}\n`);
              } else {
                console.log(`[💭 ${sb.bot.username} (${sb.role.toUpperCase()})] No deliberation recorded yet.\n`);
              }
            }
          }
          console.log('====================================================\n');
        } else if (trimmed === '!stop') {
          handleShutdown('!stop command');
        }
      });

      // Start the collaborative survival loop
      await orchestrator.runCooperativeSurvival(opts.steps);
    } else {
      console.warn('[Minecraft] Some bots failed to spawn within timeout limit.');
    }
  } catch (err) {
    console.error('[Fatal Error]', err.message);
    orchestrator.stopAll('Fatal error');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
