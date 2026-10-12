# MIKA — Autonomous Minecraft Learning Agent & Multi-Bot Swarm

[![Tests](https://img.shields.io/badge/tests-221%20passing-brightgreen.svg)](tests/)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-blue.svg)](package.json)
[![Python](https://img.shields.io/badge/python-3.10%2B%20%7C%20PyTorch-yellow.svg)](src/train/)
[![Model](https://img.shields.io/badge/active%20model-LoRA%20v1.2.0%20(Loss%201.52)-purple.svg)](data/models/)
[![Minecraft](https://img.shields.io/badge/minecraft-1.20.x%20--%201.21.x%20Java-orange.svg)](https://www.minecraft.net/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**MIKA** is an **Artificial Life (ALife) progressive learning agent and collaborative multi-bot swarm** for **Minecraft Java Edition**. 

Rather than relying on brittle, hardcoded scripts, MIKA is built on **foundational rules, sensory observation, empirical outcome verification, and adaptive learning**. It features a dual-brain architecture combining deterministic sub-second motor reflexes with fine-tuned neural models (PyTorch + LoRA) and local LLM deliberation (Qwen 3.5 via Ollama), supported by a decentralized multi-agent blackboard for team survival.

---

## Table of Contents

- [Core Principles](#core-principles)
- [System Architecture](#system-architecture)
- [Key Features](#key-features)
  - [1. Single-Bot Autonomous Survival](#1-single-bot-autonomous-survival)
  - [2. Multi-Agent Collaborative Swarm](#2-multi-agent-collaborative-swarm)
  - [3. End-to-End Autonomous Python Learning Pipeline](#3-end-to-end-autonomous-python-learning-pipeline)
  - [4. Fast Headless Simulation Engine](#4-fast-headless-simulation-engine)
- [Quick Start](#quick-start)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration & Environment Security](#configuration--environment-security)
  - [Connecting to Minecraft](#connecting-to-minecraft)
  - [Running Multi-Bot Swarm](#running-multi-bot-swarm)
  - [Training & Pipeline Commands](#training--pipeline-commands)
  - [Running the Test Suite](#running-the-test-suite)
- [In-Game Chat Commands](#in-game-chat-commands)
- [Project Directory Structure](#project-directory-structure)
- [Safety, Security & Privacy Guardrails](#safety-security--privacy-guardrails)
- [Contributing](#contributing)
- [License](#license)

---

## Core Principles

1. **Foundational Rules over Hardcoded Scripts**: Procedural worlds change dynamically. MIKA decomposes goals into prerequisite Directed Acyclic Graphs (DAGs) and adapts when terrain or resources differ.
2. **Never Assume Success**: Every physical action is verified through pre- and post-observation state deltas ($\Delta\text{Health}$, $\Delta\text{Hunger}$, $\Delta\text{Inventory}$).
3. **Mortal Survival Over Long-Term Goals**: A 6-tier interrupt hierarchy ensures threats (creepers, low HP, starvation) immediately override high-level construction or mining tasks.
4. **Failure Recovery & Circuit Breakers**: Detects consecutive failures, diagnoses root causes (unreachable, missing tool, blocked path), and switches strategies to prevent infinite loops.
5. **Continuous Learning**: Records structured experiences into persistent memory and fine-tunes domain-specific LoRA adapters with verifiable acceptance criteria.

---

## System Architecture

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │                        MINECRAFT GAME WORLD                            │
 └───────────────────▲────────────────────────────────┬───────────────────┘
                     │ Actions                        │ Observations
                     │                                ▼
       ┌─────────────┴─────────────┐    ┌─────────────────────────────┐
       │     Action Executor       │    │    World Observation        │
       │   - Strict Allowlist      │    │   - Bounded voxel snapshot  │
       │   - Rate-limited chat     │    │   - Threat & entity radar   │
       │   - Pathfinder movement   │    │   - Daylight phase tracking │
       └─────────────▲─────────────┘    └──────────────┬──────────────┘
                     │                                 │
     ┌───────────────┴─────────────────┐               │
     │    SURVIVAL POLICY HIERARCHY    │               │
     │  - Tier 1: Mortal danger retreat│◄──────────────┤
     │  - Tier 2: Starvation eating    │ (Emergency    │
     │  - Tier 3: Environmental hazard │  Preemption)  │
     │  - Tier 4: Emergency shelter    │               │
     └───────────────▲─────────────────┘               │
                     │ (Safe state)                    ▼
       ┌─────────────┴─────────────┐    ┌─────────────────────────────┐
       │   Goal Planner (DAG) /    │    │  Mistake & Memory Store     │
       │   LoRA Policy / Qwen LLM  │◄───┤  - data/memory.json         │
       │   - Prerequisite checking │    │  - Adaptive Thinking Engine │
       │   - Redundancy pruning    │    │  - Human !good / !bad labels│
       └─────────────┬─────────────┘    └─────────────────────────────┘
                     │
                     ▼
       ┌───────────────────────────┐    ┌─────────────────────────────┐
       │   Outcome Evaluator       ├───►│  Immutable Experience Log   │
       │   - Health / Food deltas  │    │  - data/raw/experiences.json│
       │   - Resource yield delta  │    │  - data/raw/feedback.jsonl  │
       └───────────────────────────┘    └─────────────────────────────┘
```

---

## Key Features

### 1. Single-Bot Autonomous Survival
- **6-Tier Survival Hierarchy**: Evaluates vitals every cycle; computes radial retreat vectors away from threat clusters.
- **Dynamic Shelter Construction**: Automatically gathers dirt/cobblestone and builds a secure defensive enclosure before nightfall.
- **Anti-Spam Rate Limiter**: Built-in outgoing chat throttling prevents Minecraft server `disconnect.spam` kicks.

### 2. Multi-Agent Collaborative Swarm
- **Shared Spatial Blackboard (`SwarmBlackboard`)**: Centralized coordinates for base shelter, categorized storage chests, resource veins, and active distress signals.
- **4 Specialized Roles**:
  - **Guard (`MIKA_Guard`)**: Proactively defends all teammates, monitors distress radar, escorts miners/farmers.
  - **Builder (`MIKA_Builder`)**: Fortifies base shelters, places craft tables, furnaces, chests, beds, and torches.
  - **Explorer (`MIKA_Explorer`)**: Maps uncharted territory, marks resource waypoints, and hunts wild animals for food.
  - **Farmer (`MIKA_Farmer`)**: Cultivates crop plots, tills soil, harvests wheat/carrots/potatoes, and restocks food chests.
- **Inter-Bot Chat Message Bus**: Enables cooperative communication (`[SWARM:DISTRESS]`, `[SWARM:NEED_RESOURCE]`, `[SWARM:SHELTER_BUILT]`).

### 3. End-to-End Autonomous Python Learning Pipeline
- **Dataset Preparation**: Cleans JSONL logs, removes duplicates, validates schemas, pairs failed actions with successful recoveries, and splits train/eval sets strictly by episode ID.
- **PyTorch LoRA Fine-Tuning (`src/train/train.py`)**: Lightweight adapter training on consumer GPUs.
- **Strict Evaluation Gate (`src/train/evaluate.py`)**: Automatically evaluates candidates against a baseline on unseen scenarios. Rejects any model that fails to outperform the baseline.
- **Model Registry & Safe Rollback (`src/train/deploy.py`)**: Deploys approved models to `data/models/versions/` and tracks active versions in `data/models/active_model.json`. Provides instant one-command rollback if needed.
- **Current Active Deployment**: Version **`v1.2.0`** (Evaluation Loss: `1.5206` vs baseline `4.5000`, $+14\%$ action accuracy gain).

### 4. Fast Headless Simulation Engine
- **Headless `SimWorld` (`src/sim/world.js`)**: Executes thousands of ticks per second without launching Minecraft, enabling rapid evolutionary policy validation and baseline benchmarking.

---

## Quick Start

### Prerequisites
1. **Node.js**: `v20.0.0` or higher
2. **Python**: `3.10` or higher with PyTorch
3. **Minecraft Java Edition**: `1.20.x` or `1.21.x` (Singleplayer Open to LAN or dedicated Paper/Spigot server)
4. *(Optional)* **Ollama**: If using Qwen 3.5 for generative LLM planning (`ollama run qwen3.5:9b`)

### Installation

```bash
# Clone the repository
git clone https://github.com/NagaInbarasan/mika-ai.git
cd mika-ai

# Install Node.js dependencies
npm install

# Install Python requirements (for training and evaluation)
pip install torch
```

### Configuration & Environment Security

Create your local `.env` configuration from the provided template:

```bash
cp .env.example .env
```

Edit `.env` to match your Minecraft setup:
```ini
# Minecraft Server
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=MIKA_Bot
MC_VERSION=false          # Set to false for auto-detection, or e.g. 1.20.4
MC_AUTH=offline           # 'offline' for LAN/offline, 'microsoft' for online

# Ollama / LLM Settings (Optional)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3.5:9b

# Storage
DATA_DIR=./data
```

> [!NOTE]
> `.env` is strictly ignored by `.gitignore` and will never be committed to git. Never share or push personal credentials or secret keys.

### Connecting to Minecraft

1. Open your Minecraft Java world.
2. Press **Esc** $\rightarrow$ **Open to LAN** $\rightarrow$ note the port displayed in chat (e.g. `56677`).
3. Launch MIKA in autonomous survival mode:

```bash
# Using CLI port override:
node src/index.js --port 56677 --auto

# Fast deterministic mode (no Ollama required):
node src/index.js --port 56677 --auto --skip-llm
```

### Running Multi-Bot Swarm

Spawn up to 4 collaborative bots simultaneously in the same world:

```bash
npm run swarm -- --port 56677 --bots 4
```

### Training & Pipeline Commands

```bash
# Run complete autonomous pipeline (clean -> train -> evaluate -> deploy)
npm run pipeline

# Run PyTorch LoRA training only
npm run train

# Evaluate candidate model vs baseline
npm run evaluate

# Deploy candidate model
npm run deploy

# Rollback to previous model version if needed
npm run rollback
```

### Running the Test Suite

MIKA includes a comprehensive 221-test automated suite covering all foundations, combat, progression, swarm coordination, and learning memory:

```bash
npm test
```

---

## In-Game Chat Commands

Type these commands directly into Minecraft chat while playing alongside MIKA:

| Command | Category | Description |
| :--- | :--- | :--- |
| `!status` | Telemetry | Displays current coordinates, health, hunger, inventory, and active goal. |
| `!observe` | Sensory | Triggers an immediate proximity and threat scan. |
| `!auto [on/off]` | Control | Toggles the autonomous survival and planning loop. |
| `!shelter` | Survival | Instructs MIKA to construct or retreat to an emergency shelter. |
| `!eat` | Survival | Consumes food from inventory to restore hunger and health. |
| `!farm` | Farming | Locates mature crops (`age === 7`), harvests them, and replants seeds. |
| `!collect <block>` | Gathering | Mines target resource (e.g., `oak_log`, `dirt`, `cobblestone`). |
| `!craft <item> [n]`| Crafting | Verifies recipe prerequisites and crafts the item. |
| `!fight [mob]` | Combat | Engages hostile mob with deterministic weapon cooldowns and shield blocks. |
| `!retreat` | Combat | Disengages from combat, retreats to safe distance, and heals. |
| `!good` / `!bad` | Feedback | Provides positive/negative reinforcement, updating persistent memory confidence. |
| `!memories` | Learning | Displays learned mistake corrections and strategy confidence scores. |
| `!think` | Cognition | (Swarm mode) Broadcasts the bot's current cognitive monologue into chat. |
| `!come` | Movement | Pathfinds directly to the player's position. |
| `!stop` | Safety | Immediately halts all actions and resets MIKA to safe idle. |

---

## Project Directory Structure

```text
mika-ai/
├── src/
│   ├── index.js              # Main CLI entry point
│   ├── config/               # Validated configuration (Zod & dotenv)
│   ├── minecraft/            # Mineflayer connection, anti-spam chat, observation collector
│   ├── planner/              # Goal DAG planner, Qwen 3.5 client, action schemas
│   ├── actions/              # Whitelisted deterministic actions (move, mine, craft, combat)
│   ├── survival/             # 6-tier survival policy, shelter construction, farming
│   ├── swarm/                # Multi-bot blackboard, roles (Guard, Builder, Miner, Farmer)
│   ├── learning/             # Persistent memory, mistake detector, recovery manager
│   ├── evaluation/           # Physical delta calculation & reward scoring
│   ├── train/                # PyTorch LoRA model, dataset tokenization, train & evaluate
│   ├── pipeline/             # Automated end-to-end learning pipeline orchestrator
│   └── sim/                  # Fast headless simulation engine (SimWorld)
├── data/
│   ├── models/               # Model registry, active_model.json, version checkpoints
│   ├── raw/                  # Immutable experiences.jsonl and feedback.jsonl
│   ├── processed/            # Cleaned training datasets (ChatML, DPO, transitions)
│   ├── reports/              # Training, preprocessing, and pipeline reports
│   └── memory.json           # Persistent learned strategies and failure patterns
├── tests/                    # 221 automated unit and integration tests
├── .env.example              # Sanitized environment configuration template
├── .gitignore                # Comprehensive secret and large-file exclusion rules
├── package.json              # Node.js project manifest & script commands
├── LICENSE                   # MIT License
└── README.md                 # Complete project documentation
```

---

## Safety, Security & Privacy Guardrails

- **Zero Secret Leakage**: `.env` and all credential files are excluded by `.gitignore`.
- **Untrusted Model Guardrails**: All neural network and LLM outputs are treated as untrusted JSON. Every action is strictly validated against schemas before execution.
- **Deterministic Survival Preemption**: Motor reflexes and retreat logic never stall waiting for inference latency.
- **Immutable Raw Data**: Experiences and feedback are append-only to preserve telemetry integrity.
- **Leakage-Free Validation**: Training and evaluation splits are strictly partitioned by episode IDs to prevent data contamination.
- **Anti-Spam Chat Throttling**: Rate limits outgoing chat messages to prevent server disconnects.

---

## Contributing

Contributions are welcome! Please follow these guidelines:
1. Ensure all new actions are registered in the allowlist schema.
2. Preserve deterministic survival and combat reflexes.
3. Run the complete test suite before submitting pull requests:
   ```bash
   npm test
   ```

---

## License

This project is licensed under the [MIT License](LICENSE).
