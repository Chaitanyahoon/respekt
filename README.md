<div align="center">
  <h1>🫡 respekt</h1>
  <p><b>Your API responses, locked and respected.</b></p>
  <p>
    <a href="https://www.npmjs.com/package/respekt"><img src="https://img.shields.io/npm/v/respekt?color=blue&style=flat-square" alt="npm" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/respekt?style=flat-square" alt="Node" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT" /></a>
  </p>
  <br/>
  <a href="https://github.com/Chaitanyahoon/respekt">
    <img src="src/Programmer%20Day%20-%20Porforever.gif" alt="Programmer Day" width="350"/>
  </a>
</div>

<br/>

**respekt** automatically infers JSON response schemas from real API traffic, locks them as contracts, and enforces them in CI/production — catching silent schema drift before your users do. **Zero manual schema writing required.**

---

## 🛠 How it works

```text
  DEV / STAGING                       CI / PRODUCTION
┌───────────────────┐              ┌───────────────────┐
│  respekt.observe() │              │  respekt.enforce() │
│  Records N samples │  lock ──►   │  Validates every   │
│  per route         │              │  response against  │
│  .respekt-traffic  │              │  locked contracts  │
│                    │              │  ⚠ RespektViolation│
└───────────────────┘              └───────────────────┘
```

1. 🕵️‍♂️ **OBSERVE** — Attach the middleware in dev. It silently records response shapes.
2. 🔒 **LOCK** — Run `npx respekt lock` to infer Zod + JSON schemas and write contract files.
3. 🛡️ **ENFORCE** — Attach the middleware in production/CI. Drift triggers a `RespektViolation`.

---

## 📦 Install

```bash
npm install respekt zod
```

---

## 🚀 Quickstart

### 1. Observe traffic

```ts
import express from 'express';
import respekt from 'respekt';

const app = express();

app.use(respekt.observe({
  routes: ['/api/*'],
  sampleSize: 50,
  outputDir: './contracts',
}));

app.get('/api/users', (req, res) => {
  res.json([
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: null },
  ]);
});

app.listen(3000);
```

### 2. Lock contracts

```bash
npx respekt lock
#  🔒 Locked: GET /api/users → GET__api_users.schema.json
# ✅ 1 contract(s) locked in ./contracts/
```

Commit the `contracts/*.schema.json` files to git.

### 3. Enforce in production

```ts
app.use(respekt.enforce({
  contractsDir: './contracts',
  onViolation: 'warn',   // 'throw' | 'warn' | 'log'
  strict: false,
}));
```

---

## 💻 CLI Reference

All commands accept `-d, --dir <path>` (default: `./contracts`).

### 🔒 `respekt lock`
Reads `.respekt-traffic.json` → writes one `*.schema.json` per route containing a Zod schema + JSON Schema + shape snapshot.

### 🔍 `respekt diff`
Structural comparison of locked vs current traffic. Exits with code `1` if drift found — ideal for CI.

```text
  ❌ GET /api/users — 2 violation(s):
     • user.age: was number, now string
     • user.role: was required, now optional
```

### 📊 `respekt report`
ASCII summary table of all routes with samples, field count, lock status, and drift score.

```text
📊 respekt — Route Report

┌─────────────────────────────────┬─────────┬────────┬──────────┬────────────┐
│ Route                           │ Samples │ Fields │ Locked?  │ Drift      │
├─────────────────────────────────┼─────────┼────────┼──────────┼────────────┤
│ GET /api/users                  │      50 │      3 │ ✅ Yes   │ ✅ None    │
└─────────────────────────────────┴─────────┴────────┴──────────┴────────────┘
```

---

## ⚙️ Config Options

### `respekt.observe(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `routes` | `string[]` | *required* | Glob patterns for routes to watch |
| `sampleSize` | `number` | `50` | Responses to collect before stabilizing |
| `outputDir` | `string` | `'./contracts'` | Traffic log output directory |

### `respekt.enforce(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `contractsDir` | `string` | `'./contracts'` | Directory with `*.schema.json` files |
| `onViolation` | `'throw' \| 'warn' \| 'log'` | `'warn'` | How to handle violations |
| `strict` | `boolean` | `false` | Extra keys count as violations |

---

## 🧠 Edge Case Behavior

| Scenario | Zod Output |
|----------|-----------|
| Field is `string` in 90%, `null` in 10% | `z.string().nullable()` |
| Key missing in some responses | `.optional()` |
| Array field | `z.array(elementType)` |
| Empty array (no items seen) | `z.array(z.unknown())` with comment |
| Nested object | Recursively inferred |
| ISO 8601 date string | `z.string().datetime()` |
| Multiple types across samples | `z.union([z.string(), z.number()])` |

---

## 🚨 `RespektViolation` Error

```ts
import { RespektViolation } from 'respekt';

try { /* ... */ } catch (err) {
  if (err instanceof RespektViolation) {
    console.log(err.violation);
    // {
    //   route: 'GET /api/users',
    //   violatedAt: '2026-05-13T10:22:00Z',
    //   violations: [
    //     { field: 'user.age', expected: 'number', received: 'string' },
    //     { field: 'user.role', expected: 'present', received: 'missing' }
    //   ]
    // }
  }
}
```

---

## ⚡ Fastify Support

```ts
import Fastify from 'fastify';
import middie from '@fastify/middie';
import respekt from 'respekt';

const app = Fastify();
await app.register(middie);
app.use(respekt.observe({ routes: ['/api/*'] }));
```

---

## 🤖 GitHub Actions CI Example

```yaml
name: Contract Check
on: [push, pull_request]

jobs:
  respekt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Check for contract drift
        run: npx respekt diff
      - name: Contract report
        run: npx respekt report
        if: always()
```

### 💡 Recommended workflow
1. **Dev:** Run with `respekt.observe()` → collect traffic
2. **Before PR:** `npx respekt lock` → commit contracts
3. **CI:** `npx respekt diff` → fails if drift
4. **Prod:** `respekt.enforce({ onViolation: 'warn' })`

---

## 🤔 Why respekt?

APIs drift silently. A backend dev renames a field, changes a type, or makes a previously-required field optional — and nobody notices until the frontend breaks in production.

**respekt** solves this by:
- Automatically learning your API's actual response shapes from real traffic
- Locking those shapes as contracts committed to git
- Failing your CI pipeline the moment a response drifts from the contract

No manual schema writing. No OpenAPI specs to maintain. Just real traffic → real contracts → real enforcement.

---

## 📋 Requirements

- **Node.js** 18+
- **zod** ^3.x (peer dependency)
- **Express** 4+/5+ or **Fastify** 4+ (with `@fastify/middie`)

## 📄 License

MIT
