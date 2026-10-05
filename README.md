# DigitalTwin

Windows desktop app for building data-driven digital twins of chemical production processes:
import SCADA/QC data, relate tables, draw a P&ID, train ML models with time delays, and
simulate and optimise process inputs.

Built with Tauri 2 (Rust), React + TypeScript, and a Python data/ML sidecar. Each project is
stored as a single SQLite file (`.dtwin`).

## Prerequisites

- Node.js 20+
- Rust (stable) with the [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/)
- Python 3.12+

## Getting started

```powershell
npm install
npm run sidecar:setup   # creates sidecar/.venv
npm run tauri dev
```

Run all tests with `npm test`. See [CLAUDE.md](CLAUDE.md) for architecture and conventions.
