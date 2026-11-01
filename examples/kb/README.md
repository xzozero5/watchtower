# Example knowledge base articles

Synthetic articles for development and demos, loaded by `pnpm db:seed` (T-107). They describe a
fictional product: no real company, customer or procedure. Replace them with your own.

Each `*.md` file is a header between `---` lines, then the Markdown body:

```
---
slug: reset-your-password      lowercase letters, digits and hyphens; unique
title: Reset your password
lang: en                       en or th
kind: article                  optional: article (default) or runbook
visibility: customer           internal (default) or customer
tags: account_access           optional, comma separated; use intent keys from examples/intents
---
# Reset your password
...
```

The seed writes each new article as **published**, version 1, and queues an indexing job. The
worker chunks and embeds it, so an article is searchable once a worker has run. A slug that exists
is left alone, so editing an article in a running instance survives a second seed.

`orgs` visibility (specific organizations) is not seedable: it needs real organization ids.
