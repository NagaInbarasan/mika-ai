# MIKA — Autonomous Minecraft Learning Agent & Multi-Bot Swarm

[![Tests](https://img.shields.io/badge/tests-264%20passing-brightgreen.svg)](tests/)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-blue.svg)](package.json)
[![Python](https://img.shields.io/badge/python-3.10%2B%20%7C%20PyTorch-yellow.svg)](src/train/)
[![Vision](https://img.shields.io/badge/vision-V1.3%20PyTorch%20%2B%20CUDA-blueviolet.svg)](src/vision/)
[![Survival Base](https://img.shields.io/badge/survival-V1.3%20Shelter%20%26%20Storage-success.svg)](src/survival/)
[![Preprocess](https://img.shields.io/badge/preprocessing-Task--Aware%20%26%20Prioritized-teal.svg)](src/data/)
[![Model](https://img.shields.io/badge/active%20model-LoRA%20v1.2.0%20(Loss%201.52)-purple.svg)](data/models/)
[![Minecraft](https://img.shields.io/badge/minecraft-1.20.x%20--%201.21.x%20Java-orange.svg)](https://www.minecraft.net/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**MIKA** is an **Artificial Life (ALife) progressive learning agent and collaborative multi-bot swarm** for **Minecraft Java Edition**. 

Rather than relying on brittle, hardcoded scripts, MIKA is built on **foundational rules, sensory observation, empirical outcome verification, computer vision, and adaptive learning**. It features a multi-system architecture combining deterministic sub-second motor reflexes, pretrained computer vision (PyTorch + CUDA), fine-tuned neural models (LoRA), local LLM deliberation (Qwen 3.5), and a decentralized multi-agent blackboard for team survival.

---

## Table of Contents

- [Core Principles](#core-principles)
- [System Architecture](#system-architecture)
- [Key Features](#key-features)
  - [1. Single-Bot Autonomous Survival](#1-single-bot-autonomous-survival)
  - [2. Multi-Agent Collaborative Swarm](#2-multi-agent-collaborative-swarm)
  - [3. End-to-End Autonomous Python Learning Pipeline](#3-end-to-end-autonomous-python-learning-pipeline)
  - [4. Fast Headless Simulation Engine](#4-fast-headless-simulation-engine)
  - [5. MIKA V1.3: Computer Vision & Visual Targeting](#5-mika-v13-computer-vision--visual-targeting)
  - [6. MIKA V1.3: Survival, Shelter, Food & Storage Master Objective](#6-mika-v13-survival-shelter-food--storage-master-objective)
  - [7. Task-Aware Dataset Preprocessing & Method Prioritization](#7-task-aware-dataset-preprocessing--method-prioritization)
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

### 5. MIKA V1.3: Computer Vision & Visual Targeting
- **Perspective Camera Engine (`src/vision/camera.js`)**: Projects first-person frustum rays into loaded chunk voxels and entities to capture authentic screenshots at configurable frequencies (default: 1 Hz).
- **Pretrained PyTorch Object Detector (`src/vision/detector.py`)**: Hardware-accelerated CNN feature extractor with GPU/CUDA execution (~15–25ms steady state).
  - **Supported Object Classes**:
    - `tree_trunk`: Oak, Birch, Spruce, Dark Oak, Acacia, Jungle wood logs.
    - `tree_foliage`: Leaves canopy & vegetation.
    - `ore`: Coal, Iron, Copper, Gold, Diamond embedded ores.
    - `animal`: Cows, Pigs, Sheep, Chickens.
    - `hostile_mob`: Zombies, Skeletons, Creepers, Spiders.
    - `water`: Water bodies, ponds, and rivers.
    - `structure`: Crafting tables, chests, furnaces, shelters, doors.
- **Cross-Modal 2D-to-3D Vision Fusion (`src/vision/fusion.js`)**: Unprojects 2D screen bounding boxes into 3D world rays and cross-references with Mineflayer's voxel ground truth. Tracks True Positives, False Positives, and Missed Targets.
- **Goal-Conditioned Target Selection (`src/vision/target-selector.js`)**: Scores candidate targets based on active goal alignment (e.g. `GATHER_WOOD_LOGS`), distance proximity ($1 / (1 + \text{dist})$), and danger safety penalties (avoids targets within 6.5m of hostile mobs).
- **Safe Visual Targeting Controller (`src/vision/targeting.js`)**:
  1. Rotates gaze to align with target center.
  2. Verifies angular alignment error ($< 15^\circ$).
  3. Verifies physical reach range ($\le 4.5$m), pathfinding closer if needed.
  4. Executes physical block mining / interaction.
  5. Empirically verifies environmental state change and inventory delta ($\Delta\text{wood} \ge +1$).
- **Separate Accuracy & Task Metrics (`src/vision/logger.js`)**: Evaluates detection accuracy (Precision, Recall, False Positives, Missed Targets, VRAM, Latency) independently of task completion rates in `data/reports/vision_report.json`.
- **Asynchronous Pipeline & Safe Fallback (`src/vision/index.js`)**: Vision inference runs asynchronously with configurable timeouts; automatically falls back to Mineflayer structured search if vision is unavailable or slow.

### 6. MIKA V1.3: Survival, Shelter, Food & Storage Master Objective
- **Persistent Task Manager (`src/tasks/task-manager.js`)**:
  - Implements an 8-state formal lifecycle state machine: `PLANNED`, `READY`, `IN_PROGRESS`, `BLOCKED`, `INTERRUPTED`, `VERIFYING`, `COMPLETED`, `FAILED`.
  - Checkpoint tracking preserves progress when threats occur (e.g. wall block 14/28 placed).
  - Interruption stack pauses tasks on Tier 1/2 threats and seamlessly resumes them from exact checkpoints once danger clears, preventing task abandonment.
  - Anti-stagnation protection detects rapid oscillation/thrashing and enforces tactical backoff cooldowns.
- **Permanent Base Shelter System (`src/survival/base-shelter.js`)**:
  - **Phase A (Site Assessment)**: Inspects local terrain for flatness, proximity to renewable trees/stone, and absence of hazards (lava, cacti, cliffs). Records coordinates and selection score in persistent memory.
  - **Phase B (Blueprint Planning)**: Generates expandable 5×5 / 7×7 rectangular shelter layouts with solid floor, walls, 1×2 door opening, roof, and interior utility slots for crafting table, furnace, chest, bed, and lighting.
  - **Phase C (Phased Verified Construction)**: Sequentially builds Floor $\to$ Walls $\to$ Entrance $\to$ Roof $\to$ Lighting, verifying physical block presence in the Minecraft world after each step.
- **Crafting Knowledge & Tool Progression (`src/crafting/knowledge.js`)**:
  - Discovers and executes recipes via Mineflayer, resolving 2×2 player crafting vs 3×3 crafting table requirements.
  - Automatically resolves multi-step missing ingredient trees (e.g. wood logs $\to$ planks $\to$ sticks $\to$ stone pickaxe).
  - Upgrades tool tiers automatically (Stone > Wood) as soon as cobblestone is available.
  - Verifies post-craft inventory deltas empirically ($\Delta\text{item} \ge +1$).
- **Food Reserves & Furnace Cooking (`src/survival/food-manager.js`)**:
  - Detects food edibility and cookability.
  - Manages 3-tier food reserves: Carried reserve (min 6–8 items), Emergency reserve (4 items), and Base storage.
  - Operates furnaces with available fuels (coal, charcoal, planks, logs, sticks) to cook raw meat into cooked food with inventory delta verification.
- **Sheep Search & Bed Crafting (`src/survival/bed-manager.js`)**:
  - Scans entities for sheep within 32m to harvest wool.
  - If no sheep are nearby, gracefully transitions task to `BLOCKED` (`reason: 'no_sheep_nearby'`) so base construction continues unhindered without infinite search or freezing.
- **Categorized Storage Organization (`src/storage/organization.js`)**:
  - Organizes items into 7 logical categories: `BUILDING`, `FOOD`, `TOOLS`, `WEAPONS_ARMOR`, `RESOURCES`, `VALUABLES`, `MISC`.
  - Enforces minimum personal survival inventory reserves (1 pickaxe, 1 sword, 1 axe, 8 torches, 16 blocks, 8 food) before depositing surplus into chests.
  - Detects full chests and manages overflow.

### 7. Task-Aware Dataset Preprocessing & Method Prioritization
- **Automated Dataset Archival (`src/data/task-aware-preprocess.js`)**:
  - Automatically snapshots raw datasets to `data/archive/raw_backup_<timestamp>/` with SHA-256 manifests and checksum verification before any preprocessing modifications occur.
- **Physical Game-State Outcome Verification**:
  - Discards unverified records where actions claimed success without verifiable environmental deltas (verifies inventory deltas for gathering/crafting, arrival radius and position movement for navigation, and food/saturation deltas for eating).
- **Condition Context Clustering**:
  - Groups experience records into granular, comparable clusters: `Task/Goal` $\times$ `Dimension` $\times$ `TimePhase (Day/Night)` $\times$ `Weather` $\times$ `HealthBucket (Critical/Low/Healthy)` $\times$ `ThreatStatus`.
  - Prevents unfair comparisons across dissimilar conditions (e.g. peaceful day gathering vs night mob raid).
- **Method Profiling & Multi-Metric Ranking**:
  - Computes attempts, verified successes, failures, duration, step counts, damage taken, and resource costs per method.
  - Prioritizes faster methods **only when reliability ($\ge 80\%$) and safety ($\le 2.0$ damage) are maintained**.
- **Fallback Preservation (Zero Silent Deletion)**:
  - Top method assigned `priority: "primary"` (weight 1.0).
  - Slower or alternative working methods assigned `priority: "fallback"` (weight 0.5) to maintain behavioral diversity.
  - Failed attempts with diagnostic errors and linked corrections preserved in `failure_recovery.jsonl` and `dpo_pairs.jsonl`.
- **Honest Model Evaluation Quality Gate**:
  - Evaluates candidate models on held-out unseen episodes.
  - Enforces that models are **never promoted solely because training loss decreased**; held-out accuracy and valid JSON schema must beat the baseline before deployment.

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
# Run complete autonomous pipeline (archive -> clean -> train -> evaluate -> deploy)
npm run pipeline

# Run task-aware dataset preprocessing & method prioritization directly
npm run preprocess:task-aware

# Run PyTorch LoRA training only
npm run train

# Evaluate candidate model vs baseline on held-out unseen episodes
npm run evaluate

# Deploy candidate model (only if quality gate passes)
npm run deploy

# Rollback to previous model version if needed
npm run rollback
```

### Running the Test Suite

MIKA includes a comprehensive 264-test automated suite covering all foundations, combat, progression, computer vision, multi-bot swarm, V1.3 survival base/shelter, and task-aware dataset preprocessing:

```bash
# Run complete test suite (264 tests, 21 suites)
npm test

# Run V1.3 Survival Base & Storage master suite (10 scenarios)
npm run test:v13

# Run live in-game verification on active Minecraft server (port 56677)
npm run test:v13:live

# Run Computer Vision object detection tests
npm run test:vision
npm run test:vision:live
```

---

## In-Game Chat Commands

Type these commands directly into Minecraft chat while playing alongside MIKA:

| Command | Category | Description |
| :--- | :--- | :--- |
| `!status` | Telemetry | Displays current coordinates, health, hunger, inventory, and active goal. |
| `!observe` | Sensory | Triggers an immediate proximity and threat scan. |
| `!vision` / `!vis` | Computer Vision | Captures perspective screenshot, detects tree trunk via PyTorch vision, and targets wood harvest. |
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
