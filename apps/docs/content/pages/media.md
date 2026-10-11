---
title: "Media and file storage"
description: "Version images and other files alongside your content."
order: 55
author: /content/authors/team.md
---

## Files share the same tree

Every file has a path, content hash, mode, and snapshot membership in the database. Files that match a collection are validated and indexed. Other files are assets: their bytes use SQL by default, or an optional private blob store. Moving bytes out of SQL does not move the file tree, branch pointers, reviews, or permissions.

## Add media with your agent

Use `list_files` to inspect the tree and `write_asset` to upload up to 512 KiB as base64. Use `read_file` to retrieve metadata or bounded binary content. Text files without a schema can also use `write_source` and `apply_changes`.

Writes require an authorized draft, its observed revision, and a retry key. An asset can be renamed or deleted in the same atomic batch as its referring document. Git treats images and other binary files as versioned files and reports conflicts when both branches replace the same asset.

## Upload and review in the browser

Open **Media library** from the site toolbar. Select your draft to upload files up to 4 MiB. The library shows the files in that view; publication still requires review and approval.

The review page compares images before and after, including additions and deletions. Recognized audio and video have playback controls. Downloads and previews stay bound to their authorized snapshots. SVG and other active document formats are downloads rather than inline previews.

In this manual, reference images with Markdown such as `![Description](/media/example.png)`. The page resolves the image in the same published or preview snapshot as the document.

## Image example

![A versioned sample image with green, violet, and gold panels.](/media/palette.png)

This image belongs to the same file tree as this guide. Replacing it in a draft produces a before-and-after media review.

## Optional private storage

Hosts can supply `assetBlobs` with immutable `put(id, bytes)` and `get(id)` methods. The docs host includes a private Vercel Blob adapter enabled by `WILDWOOD_DOCS_ASSET_BLOB_TOKEN` (or Vercel’s linked `BLOB_READ_WRITE_TOKEN`). Existing SQL files remain readable; new unmodeled files use the configured asset store. Keep that store connected while any snapshot references its files.

## Git storage maintenance

Git exports and merges store new objects as incremental packs in dedicated database tables. A maintenance compaction combines duplicate objects and reclaims superseded pack bytes. Old archive IDs redirect to the compacted pack, so historical commits, active branches, and pinned merge plans remain usable. This does not delete content history or collect external assets.
