---
id: ui-modal-blur-backdrop-pattern
title: "Modal blur backdrop pattern"
type: lesson
summary: "For a modal with blur, keep the backdrop as one fixed layer and the dialog as a separate centered layer so blur, click targets, and z-index stay predictable."
topic_path: [ui, modal, backdrop]
tags: [modal, blur, backdrop, z-index]
scope: all-projects
recall_when:
  - modal mit blur
  - creating a modal backdrop
  - styling dialog overlay z-index
related: []
related_via: []
sensitivity: team
source: "public sample vault"
confidence: 0.9
created: 2026-05-01
updated: 2026-05-01
---

## Rule
Separate the modal backdrop from the modal panel.

## Why
Putting blur, click capture, and dialog content into one element often causes z-index and pointer-event bugs.

## How to apply
Use a fixed backdrop layer with blur and a separate dialog layer above it.
