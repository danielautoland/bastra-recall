---
id: css-input-focus-ring-stacking
title: "Do not stack focus styles on inputs"
type: lesson
summary: "When building inputs, avoid stacking ring, outline, and custom focus styles; use one clear :focus-visible treatment so the control does not show double focus rings."
topic_path: [css, input, focus]
tags: [css, input, focus-ring, accessibility]
scope: all-projects
recall_when:
  - creating new input component
  - neuen input bauen
  - writing input or form css
related: []
related_via: []
sensitivity: team
source: "public sample vault"
confidence: 0.95
created: 2026-05-01
updated: 2026-05-01
---

## Rule
Use one focus treatment for form controls.

## Why
Stacking browser outlines, ring utilities, and custom focus borders creates a noisy double-ring effect.

## How to apply
When writing input or form CSS, pick a single visible focus style and test keyboard focus.
