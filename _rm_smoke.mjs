import { buildResourceMatrix } from "./lib/resource-matrix";

// Scenario: workstream (parent) + task (leaf), Alice assigned to both.
// Expected: exactly 40 h attributed to Alice (from the leaf only).
const tasks = [
  {
    id: "ws",
    title: "Tool Delivery",
    type: "EPIC",
    startDate: new Date("2026-04-20"),
    endDate: new Date("2026-05-15"),
    effortHours: 40,
    assignee: "Alice",
    resourceAllocated: null,
    parentId: null,
  },
  {
    id: "leaf",
    title: "Install fixture",
    type: "TASK",
    startDate: new Date("2026-04-20"),
    endDate: new Date("2026-05-15"),
    effortHours: 40,
    assignee: "Alice",
    resourceAllocated: null,
    parentId: "ws",
  },
];

const matrix = buildResourceMatrix({
  tasks,
  roster: ["Alice", "Bob"],
  windowStart: new Date("2026-04-19"),
  weeks: 12,
});
const aliceTotal = matrix.rows.find((r) => r.name === "Alice")?.totalHours ?? 0;
console.log("Alice total (expect ~40):", aliceTotal);

// Scenario 2: workstream has Bob, leaf has no assignee.
// Expected: leaf's hours flow to Bob via ancestor inheritance.
const t2 = [
  {
    id: "ws2",
    title: "Spare WS",
    type: "EPIC",
    startDate: new Date("2026-04-20"),
    endDate: new Date("2026-05-15"),
    effortHours: 0, // parent rollup, no manual hours
    assignee: "Bob",
    resourceAllocated: null,
    parentId: null,
  },
  {
    id: "leaf2",
    title: "Leaf with no assignee",
    type: "TASK",
    startDate: new Date("2026-04-20"),
    endDate: new Date("2026-05-15"),
    effortHours: 20,
    assignee: null,
    resourceAllocated: null,
    parentId: "ws2",
  },
];
const m2 = buildResourceMatrix({
  tasks: t2,
  roster: ["Alice", "Bob"],
  windowStart: new Date("2026-04-19"),
  weeks: 12,
});
const bobTotal = m2.rows.find((r) => r.name === "Bob")?.totalHours ?? 0;
console.log("Bob inherited total (expect ~20):", bobTotal);
console.log(
  "Unassigned bucket (expect null):",
  m2.unassigned ? m2.unassigned.totalHours : null,
);
