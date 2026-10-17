/**
 * One turn per delivery.
 *
 * These tests encode the two failures seen in production on 2026-10-17:
 * a single Growth Engine dispatch starting two or three concurrent agent
 * sessions on the same task, and BasicOps forwarding one identical webhook
 * twice a second apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryGate, bodyText, deliveryKey } from "../src/delivery.ts";

const dispatchHtml =
  '<p>@<span class="user-link record-link" _tableid="3922" _id="81299">Claude-Agent</span> — begin this assigned Growth Engine task now.</p>' +
  "<p><strong>Work item:</strong> seo-pr:30</p>";

const webhook = (over: Record<string, any> = {}) => ({
  event: "basicops.task.message.created",
  convId: "2213873",
  request: dispatchHtml,
  context: { taskId: 2213873, projectId: 69588, userId: 81314, messageId: "dm2675120" },
  ...over,
});

// The localhost wake carries the same instruction, no messageId and no userId.
const wake = (over: Record<string, any> = {}) => ({
  event: "basicops.task.message.created",
  convId: "2213873",
  request: dispatchHtml,
  context: { taskId: 2213873, projectId: 69588 },
  ...over,
});

test("the posted webhook and the localhost wake of one dispatch are one delivery", () => {
  const gate = new DeliveryGate();
  assert.equal(gate.firstDelivery(webhook()), true);
  assert.equal(gate.firstDelivery(wake()), false, "the wake must not start a second turn");
});

test("an identical webhook forwarded twice starts one turn", () => {
  const gate = new DeliveryGate();
  assert.equal(gate.firstDelivery(webhook()), true);
  assert.equal(gate.firstDelivery(webhook()), false, "the repeat is dropped");
});

test("a repeat is matched on what the message says, not on its id", () => {
  // The two routes share only the body: the wake has no messageId at all.
  assert.equal(deliveryKey(webhook()), deliveryKey(wake()));
  assert.notEqual(deliveryKey(webhook()), deliveryKey(webhook({ request: "<p>something else</p>" })));
  assert.notEqual(deliveryKey(webhook()), deliveryKey(webhook({ convId: "2213875" })));
});

test("markup and whitespace differences do not hide a repeat", () => {
  const gate = new DeliveryGate();
  assert.equal(gate.firstDelivery(webhook()), true);
  const reflowed = webhook({ request: dispatchHtml.replace(/></g, ">\n  <") + "\n" });
  assert.equal(gate.firstDelivery(reflowed), false);
  assert.equal(bodyText("<p>a&nbsp;&amp; b</p>\n<p>  c </p>"), "a & b c");
});

test("the same request sent again later is a real message, not a repeat", () => {
  let clock = 1_000_000;
  const gate = new DeliveryGate({ windowMs: 120_000, now: () => clock });
  assert.equal(gate.firstDelivery(webhook()), true);
  clock += 119_000;
  assert.equal(gate.firstDelivery(webhook()), false);
  clock += 2_000; // past the window: Justin repeating himself must be heard
  assert.equal(gate.firstDelivery(webhook()), true);
});

test("a repeat inside the window does not extend the window", () => {
  let clock = 0;
  const gate = new DeliveryGate({ windowMs: 100, now: () => clock });
  assert.equal(gate.firstDelivery(webhook()), true);
  clock = 90;
  assert.equal(gate.firstDelivery(webhook()), false);
  clock = 101;
  assert.equal(gate.firstDelivery(webhook()), true);
});

test("different conversations are independent", () => {
  const gate = new DeliveryGate();
  assert.equal(gate.firstDelivery(webhook()), true);
  assert.equal(gate.firstDelivery(webhook({ convId: "2213875", context: { taskId: 2213875 } })), true);
});

test("a state change with no body is deduplicated on its own event", () => {
  const gate = new DeliveryGate();
  const change = { event: "basicops.task.updated", convId: "99", request: "", context: { taskId: 99, messageId: "" } };
  assert.equal(gate.firstDelivery(change), true);
  assert.equal(gate.firstDelivery({ ...change }), false);
  assert.equal(gate.firstDelivery({ ...change, event: "basicops.task.completed" }), true);
});

test("two events on one conversation run in order, not side by side", async () => {
  const gate = new DeliveryGate();
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));

  const a = gate.run("2213873", async () => {
    order.push("a:start");
    await first;
    order.push("a:end");
  });
  const b = gate.run("2213873", async () => {
    order.push("b:start");
  });

  assert.equal(a.accepted, true);
  assert.equal(b.accepted, true);
  assert.equal(b.queued, 2, "the second turn waits behind the first");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["a:start"], "the assignment notice must not run beside the instruction");
  releaseFirst();
  await Promise.all([a.result, b.result]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
  assert.equal(gate.depth("2213873"), 0);
});

test("turns on different conversations still overlap", async () => {
  const gate = new DeliveryGate();
  const order: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const a = gate.run("1", async () => {
    order.push("a:start");
    await held;
  });
  const b = gate.run("2", async () => {
    order.push("b:start");
  });
  await b.result;
  assert.deepEqual(order, ["a:start", "b:start"]);
  release();
  await a.result;
});

test("one failed turn does not block the turns queued behind it", async () => {
  const gate = new DeliveryGate();
  const ran: string[] = [];
  const bad = gate.run("1", async () => {
    throw new Error("turn failed");
  });
  const good = gate.run("1", async () => {
    ran.push("good");
  });
  await assert.rejects(() => bad.result!, /turn failed/);
  await good.result;
  assert.deepEqual(ran, ["good"]);
  await new Promise((r) => setImmediate(r)); // the lane bookkeeping settles a tick later
  assert.equal(gate.depth("1"), 0, "a drained lane is forgotten, so it cannot leak");
});

test("a backed-up conversation is reported instead of queueing without limit", async () => {
  const gate = new DeliveryGate({ maxQueued: 2 });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const first = gate.run("1", async () => {
    await held;
  });
  const second = gate.run("1", async () => {});
  const third = gate.run("1", async () => {});
  assert.equal(second.accepted, true);
  assert.equal(third.accepted, false, "a stuck conversation must surface, not pile up");
  assert.equal(third.queued, 2);
  release();
  await Promise.all([first.result, second.result]);
  assert.equal(gate.run("1", async () => {}).accepted, true, "the lane recovers once it drains");
});
