---
title: Tr33!!!
author: ../authors/jeff.md
description: An introduction to Tr33, a Git-based content management system with a type-safe API for managing and querying Markdown and JSON content.
---

# Tr33

::testimonial[I found this to be _really_ effective]{#01ab2cd3efg author=../authors/jeff.md}

Tr33 is a powerful Git-based content management system that allows you to manage and query content stored in Git repositories using a type-safe API. It provides a seamless way to work with both Markdown and JSON content while maintaining the benefits of version control.

## Key Features

- **Git Integration**: Seamlessly works with Git repositories for version control
- **Type-Safe API**: Built with TypeScript and Zod for end-to-end type safety
- **Content Collections**: Define strongly-typed collections for your content
- **Flexible Querying**: Powerful query API for finding and filtering content
- **Markdown Support**: Built-in support for Markdown content with frontmatter
- **Relations**: Define relationships between different content types

## Basic Usage

```typescript
import { defineConfig, createClient } from "tr33";
import { z } from "zod";

// Define your content collections
const page = z.collection({
  name: "page",
  schema: z.object({
    title: z.filter(z.string()),
    body: z.markdown(),
  }),
  match: "docs/*.md",
  type: "markdown",
});

// Create your configuration
const config = defineConfig({
  org: "your-org",
  repo: "your-repo",
  ref: "main",
  remote: "/path/to/repo",
  version: "1",
  orm: {
    page,
  },
});

// Initialize the client
const tr33 = createClient(config, database);

// Query your content
const result = await tr33.page.findMany({
  where: {
    path: { like: "docs/%" },
    title: { eq: "My Page" },
  },
});
```

## Content Collections

Collections are the core building blocks of Tr33. They define the structure and location of your content:

- `name`: Unique identifier for the collection
- `schema`: Zod schema defining the content structure
- `match`: Glob pattern for matching files
- `type`: Content type ("markdown" or "json")

## Querying

Tr33 provides a powerful query API for finding and filtering content:

```typescript
// Find a single item
const page = await tr33.page.findFirst({
  where: {
    title: { eq: "Home" },
  },
});

// Find multiple items with filters
const pages = await tr33.page.findMany({
  where: {
    path: { like: "docs/%" },
    title: { eq: "Documentation" },
  },
});
```

## Git Operations

Tr33 provides a low-level Git API for managing your content:

```typescript
// Initialize the repository
await tr33._.git.init();

// Fetch latest changes
await tr33._.git.fetch();

// Checkout a branch
await tr33._.git.checkout();

// Show file contents
const content = await tr33._.git.show({ path: "docs/page.md" });
```

## Type Safety

Tr33 leverages TypeScript and Zod to provide end-to-end type safety:

- Collection schemas are validated at runtime
- Query results are fully typed
- Relations between collections are type-safe
- Filter operations are type-checked

## Getting Started

1. Install Tr33 in your project
2. Define your content collections
3. Create your configuration
4. Initialize the client
5. Start querying your content

For more detailed information, check out the [API Reference](./api.md) and [Guides](./guides.md).
