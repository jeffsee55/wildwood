export const initialFiles = {
  "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
  "content/docs/a.md":
    "---\ntitle: hello from a\nauthor: ../authors/jeff.json\n---\n\n# a",
  "content/docs/b.md":
    "---\ntitle: hello from b\nauthor: ../authors/jeff.json\n---\n\n# b",
  "content/unrelated/c.json": "{}",
  "package.json": "{\"name\":\"tr33-mono\"}",
  "README.md": "# README",
};
