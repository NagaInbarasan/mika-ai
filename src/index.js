import fs from 'fs';
import path from 'path';
import config from './config/index.js';
import { checkQwenAvailable, testQwenConnection } from './planner/qwen.js';
import { createBotConnection, disconnectBot, waitForSpawn } from './minecraft/connect.js';

// Parse simple CLI arguments (e.g. node src/index.js --port 54321)
function parseArgs() {
  const args = process.argv.slice(2);
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      overrides.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      overrides.host = args[i + 1];
      i++;
    } else if (args[i] === '--check-only') {
      overrides.checkOnly = true;
    } else if (args[i] === '--auto' || args[i] === '--survive') {
      overrides.autoSurvive = true;
    } else if (args[i] === '--test-qwen') {
      overrides.testQwen = true;
    } else if (args[i] === '--swarm') {
      overrides.swarm = true;
    } else if (args[i] === '--bots' && args[i + 1]) {
      overrides.bots = Math.max(1, Math.min(4, parseInt(args[i + 1], 10)));
      i++;
    } else if (args[i] === '--skip-llm' || args[i] === '--no-qwen') {
      overrides.skipLlm = true;
    } else if (args[i] === '--steps' && args[i + 1]) {
      overrides.steps = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--continuous' || args[i] === '--keep-running') {
      overrides.continuous = true;
    } else if (args[i] === '--goal' && args[i + 1]) {
      overrides.goal = args[i + 1];
      i++;
    } else if (args[i].startsWith('--goal=')) {
      overrides.goal = args[i].slice(7);
    } else if (args[i] === '--model-version' && args[i + 1]) {
      overrides.modelVersion = args[i + 1];
      i++;
    }
  }
  return overrides;
}

async function main() {
  const overrides = parseArgs();
  const effectivePort = overrides.port !== undefined ? overrides.port : config.minecraft.port;
  const effectiveHost = overrides.host || config.minecraft.host;

  // Handle Multi-Agent Swarm mode directly if --swarm flag passed
  if (overrides.swarm) {
    const { SwarmOrchestrator } = await import('./swarm/orchestrator.js');
    const orchestrator = new SwarmOrchestrator({
      botCount: overrides.bots || 4,
      host: effectiveHost,
      port: effectivePort
    });

    process.on('SIGINT', () => {
      console.log('\n[System] SIGINT received. Stopping swarm...');
      orchestrator.stopAll('SIGINT');
      process.exit(0);
    });

    await orchestrator.spawnSwarm({
      botCount: overrides.bots || 4,
      host: effectiveHost,
      port: effectivePort
    });
    const spawned = await orchestrator.waitForAllSpawns(35000);
    if (spawned) {
      await orchestrator.runCooperativeSurvival(50);
    }
    return;
  }

  let activeModelVersion = overrides.modelVersion;
  if (!activeModelVersion) {
    try {
      const activeModelPath = path.resolve(process.cwd(), 'data/models/active_model.json');
      if (fs.existsSync(activeModelPath)) {
        const raw = JSON.parse(fs.readFileSync(activeModelPath, 'utf8'));
        activeModelVersion = raw.active_version || 'v1.3.0';
      }
    } catch (_) {
      activeModelVersion = 'v1.3.0';
    }
  }
  if (!activeModelVersion) activeModelVersion = 'v1.3.0';

  console.log('====================================================');
  console.log('  MIKA Minecraft ALife Autonomous Simulation Bot    ');
  console.log('====================================================');
  console.log(`Minecraft Target : ${effectiveHost}:${effectivePort} (${config.minecraft.version || 'auto-detect'})`);
  console.log(`Bot Username     : ${config.minecraft.username}`);
  console.log(`Active Model     : ${activeModelVersion}`);
  if (overrides.goal) {
    console.log(`Target Goal      : ${overrides.goal}`);
  }
  console.log(`LLM Planner      : ${overrides.skipLlm ? 'SKIPPED (Deterministic Reflex / Rules)' : `${config.ollama.model} @ ${config.ollama.host}`}`);
  console.log('====================================================\n');

  // Step 1: Verify Qwen 3.5 9B availability (unless --skip-llm is provided)
  if (!overrides.skipLlm) {
    console.log('[Init] Step 1: Checking LLM Reasoner (Qwen 3.5 9B)...');
    if (overrides.testQwen) {
      const qwenResult = await testQwenConnection();
      if (!qwenResult.success) {
        console.warn('[Init] Qwen check failed or Ollama is offline.');
      }
    } else {
      const check = await checkQwenAvailable();
      if (check.available) {
        console.log(`[Init] Qwen 3.5 9B verified on Ollama (model: ${check.model.name}). Ready!\n`);
      } else {
        console.warn(`[Init] Warning: Qwen 3.5 9B not detected (${check.error || 'not found'}).`);
      }
    }
  } else {
    console.log('[Init] Step 1: Skipping Qwen LLM check (--skip-llm active). Running fast deterministic engine.\n');
  }

  if (overrides.checkOnly) {
    console.log('[Init] --check-only flag provided. Exiting after system check.');
    process.exit(0);
  }

  // Step 2: Establish Minecraft connection
  console.log('[Init] Step 2: Connecting to Minecraft world...');
  let bot;
  try {
    bot = createBotConnection({
      host: effectiveHost,
      port: effectivePort,
      goal: overrides.goal,
      modelVersion: activeModelVersion
    });
  } catch (err) {
    console.error('[Init] Failed to initiate Mineflayer bot:', err.message);
    process.exit(1);
  }

  // Graceful shutdown handling
  let isShuttingDown = false;
  const handleShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[System] Received ${signal}. Shutting down MIKA cleanly...`);
    if (bot) {
      disconnectBot(bot, `Process terminated via ${signal}`);
    }
    setTimeout(() => {
      console.log('[System] Process complete. Goodbye!');
      process.exit(0);
    }, 1000);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    console.log('[Init] Waiting for bot spawn event...');
    await waitForSpawn(bot, 30000);
    console.log('\n[Milestone A SUCCESS] Bot successfully connected, spawned, and logged lifecycle events!');
    console.log('[Info] Type Ctrl+C in this terminal, or type "!stop" in Minecraft chat to disconnect the bot cleanly.');
    console.log('[Console Ready] You can also type commands directly here: !status, !shelter, !survive, !observe, !good, !bad\n');

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed && bot) {
        bot.emit('chat', 'Console_User', trimmed);
      }
    });

    if (overrides.autoSurvive && bot.autonomousSurvival) {
      const stepBudget = overrides.continuous ? 1000000 : (overrides.steps || 1000);
      const isContinuous = !!overrides.continuous;
      console.log(`[System] --auto flag provided. Automatically starting Autonomous Survival loop (${isContinuous ? 'Continuous mode' : `${stepBudget} steps`})...`);
      setTimeout(() => {
        if (bot.isReady && !bot.isAutonomous) {
          bot.isAutonomous = true;
          bot.autonomousSurvival.start(bot, stepBudget, isContinuous);
        }
      }, 1500);
    }
  } catch (err) {
    console.warn(`[Minecraft] Could not complete spawn: ${err.message}`);
    console.log('\n----------------------------------------------------');
    console.log('To connect to your installed Minecraft world:');
    console.log('1. Open Minecraft Java Edition (1.21.x).');
    console.log('2. Singleplayer -> Enter any world.');
    console.log('3. Press Esc -> Click "Open to LAN" (allow cheats: on).');
    console.log('4. Note the LAN port shown in chat (e.g. 52341).');
    console.log(`5. Run: node src/index.js --port <port>`);
    console.log('   or update MC_PORT in your .env file.');
    console.log('----------------------------------------------------\n');
  }
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
