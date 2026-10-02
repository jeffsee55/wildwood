---
title: "Git at the boundary"
description: "Keep Git compatibility without writing Git objects on every keystroke."
order: 50
author: /content/authors/team.md
---

## Import and export

The core imports committed Git trees and preserves original bytes, file modes, and reachable history. Export materializes a Git commit when needed. Draft edits do not immediately build Git objects.

## Serving a repository

The experimental authenticated Git HTTP handler supports fetch and clone from a materialized bare repository using native Git. Push and synchronization with CMS refs are not implemented yet.

A persistent Node host is needed for that handler. The docs website does not expose it. Blob storage is replaceable; SQL storage works for the local demo.
