---
name: Research / investigation
about: A self-contained investigation that produces grounding (a repro + REPORT.md), not shipped code
title: ""
labels: ["research"]
---

<!-- Add an area:* label and a priority (usually P2/P3). -->

## Question

<!-- The single question this investigation answers. -->

## Hypothesis

<!-- Current best guess. Mark it as a guess — it is not a fact until reproduced. -->

## Repro plan

<!--
How to reproduce locally. Prefer a real local run over inferring from CI.
We build these tools and can run them here (QEMU: x86 under HVF, arm64 under TCG — slow but real).
-->

## Done-when

A `test/lab/<topic>/REPORT.md` records the real observed behaviour and a verdict,
and any resulting durable fact is written into the doc that governs the area
(scoped `.github/instructions/*.md`, `docs/`, or `DESIGN.md`).
