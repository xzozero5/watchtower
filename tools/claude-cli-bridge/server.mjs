// Legacy runner remains Claude-only, including when AI_BRIDGE_MODE=codex is set.
import { startBridge } from '../ai-bridge/server.mjs';
startBridge({ legacy: true });
