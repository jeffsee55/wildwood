---
title: "Content that stays put"
description: "Start with published content, create a draft, and share an immutable preview."
order: 10
author: /content/authors/team.md
---

Wildwood is a Git-compatible CMS built around immutable content snapshots.

## Try the working model

Choose **Create draft** in the toolbar. Choose **Edit**, then select any mapped content on the page. Save your source to see the server-rendered result. The draft moves forward; the published site stays where it was.

Open **Share** and create a link to **This exact snapshot**. Edit again: that preview keeps its original content. Choose **Latest draft changes** when you want a link that follows your work.

Switch to French to see a translated introduction. The other pages fall back to English. References resolve in the same snapshot and language as the page.

## A small surface

The core exposes collections, queries, branches, mutations, and snapshots. The docs run directly on that core with SQLite. No embedded IDE, Git checkout, or remote service is required to read content.
