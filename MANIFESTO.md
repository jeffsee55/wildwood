# Wildwood principles

1. Content is plain Markdown and JSON, described by typed schemas.
2. Every read belongs to an immutable snapshot and explicit variant context.
3. Draft creation is cheap. Edits never silently overwrite a newer revision.
4. Agents discover the model, make bounded changes, validate, and return a preview and review link.
5. Humans approve exact revisions. A newer edit cannot reuse an older approval.
6. Publication is durable and retryable. An uncertain response is reconciled with the same operation key.
7. The database and blob store are authoritative. Git is an interoperability boundary, not a serverless runtime dependency.
8. Permissions are enforced by the server. Source maps, snapshot IDs, URLs, and tool annotations are not authority.
9. The website itself is the editing surface. Keep the interface small, accessible, and independent of host styles.
10. The docs site is customer zero. A feature is complete only when its real integration is exercised.
