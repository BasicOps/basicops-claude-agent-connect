#!/usr/bin/env node
// Runs the drawer bridge on this Mac. See src/bridge.ts.
(process as any).emitWarning = () => {};
const { startBridge } = await import("./bridge.js");
await startBridge().catch((e: any) => {
  console.error(`[bridge] ${e.message}`);
  process.exit(1);
});
