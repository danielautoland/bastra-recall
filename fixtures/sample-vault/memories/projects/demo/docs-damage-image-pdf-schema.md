---
id: docs-damage-image-pdf-schema
title: "Damage image PDF schema"
type: project-fact
summary: "Damage report PDFs store each Schadensbild image with a stable image id, caption, page reference, and source path so generated reports can link images back to the original evidence."
topic_path: [documents, pdf, images]
tags: [pdf, schadensbild, images, schema]
scope: demo
recall_when:
  - schadensbild pdf
  - reading damage report image metadata
  - generating pdf sidecar schema
related: []
related_via: []
sensitivity: team
source: "public sample vault"
confidence: 0.85
created: 2026-05-01
updated: 2026-05-01
---

## Fact
Damage report sidecars should preserve image provenance.

## Why
Users need to trace report images back to the original source when validating generated PDFs.

## How to apply
Capture image id, caption, page, and source path together.
