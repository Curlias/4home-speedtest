# 4HOME Speedtest

Node.js speed test and network diagnostics page for 4HOME.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Render deploy

This repository includes `render.yaml` for a free Render Web Service.

Free Render services do not preserve local filesystem changes after restarts, so `RESULTS_PATH` points to `/tmp/4home-speedtest/results.jsonl` for test deployments. For persistent diagnostic codes/results, upgrade the service to a paid compute plan and attach a disk mounted at `/var/data`, then set:

```bash
RESULTS_PATH=/var/data/results.jsonl
```
