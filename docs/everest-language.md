# Everest Language Reference — v1

## Principles

1. **Convention over configuration.** A service file says only what makes it different. Everything else comes from its archetype and the basecamp.
2. **One authored form, one effective form.** People and the LLM edit short authored files. A deterministic resolver merges all layers into an effective spec per service, annotated with where each value came from.
3. **Overrides are cheap; deviations are loud.** Setting a value the parent allows is an override and needs nothing. Breaking a rule needs a `deviations:` entry with a reason.
4. **Contracts are owned.** Every event, command, and API has exactly one owning service and a typed shape. Others reference it and never redefine it.
5. **AI writes it; people verify it.** Plain YAML, maps (not arrays) for named things, a tiny inline type syntax, no expressions or computed values.
6. **Deterministic core.** Resolution, validation, and rule checks are plain code. The LLM only proposes edits.

---

## Layers

A service's effective spec merges five layers, lowest priority first:

```
basecamp → archetype → stack → ecosystem → service
```

The active profile (`dev`, `stage`, `prod`) is applied last.

### Merge rules

| Pattern | Meaning |
|---------|---------|
| Maps (`api.rest`, `stores`, `consumes`, `calls`, `sends`, `accepts`, `env`) | Merge by key |
| Scalars and plain lists | Replace |
| `key+: [...]` | Append to inherited list |
| `key: null` | Remove inherited entry |
| Locked key changed by a later layer | Validation error |

---

## Repositories and file layout

The **basecamp** lives in its own git repo (`everest-basecamp`), with tagged versions. Ecosystems pin it with `extends: everest-basecamp@1.0`.

```
everest-basecamp/
  basecamp.yaml
  rules.yaml
  archetypes/
    http.yaml  messaging.yaml  provider.yaml  adaptor.yaml
    worker.yaml  gateway.yaml  web-app.yaml
  stacks/
    node-express.yaml  spring-boot.yaml  python-fastapi.yaml
```

An **ecosystem** is its own git repo:

```
<ecosystem>/
  ecosystem.yaml
  contracts/
    events.yaml
    commands.yaml
    types.yaml
  services/
    <service-id>.yaml
```

---

## basecamp.yaml (seed)

```yaml
basecamp: everest-basecamp
version: 1.0.0
defaults:
  stack: node-express
  runtime:   { port: 8080, health: /health }
  deploy:    { namespace: rkamradt-platform, registry: ghcr.io/rkamradt, pullPolicy: Always }
  messaging: { broker: kafka, serialization: json, delivery: at-least-once, dlq: true }
  persistence:
    relational: postgres-16
    document:   mongodb-7
    kv:         redis-7
    cache:      redis-7
    blob:       minio
stacks: [node-express, spring-boot, python-fastapi]
```

---

## Archetypes

| Archetype  | Inbound                        | Outbound                            | Persistence          | Naming                 |
|------------|--------------------------------|--------------------------------------|----------------------|------------------------|
| `http`     | rest, grpc, consume, accept    | rest, grpc, publish, send            | any                  | none                   |
| `messaging`| consume, accept                | publish, send, rest                  | kv, cache            | none                   |
| `provider` | accept                         | publish, foreign-outbound            | kv, cache            | `-provider` / `Provider` |
| `adaptor`  | foreign-inbound                | publish                              | kv                   | `-adaptor` / `Adaptor`   |
| `worker`   | schedule                       | rest, publish, send                  | any                  | none                   |
| `gateway`  | rest                           | rest, grpc                           | none                 | none                   |
| `web-app`  | browser                        | rest (to its gateway only)           | none                 | none                   |

`provider` requires `foreign.outbound`. `adaptor` requires `foreign.inbound`. `worker` requires `schedule:`.

---

## Communication modes

| Mode             | Owner declares                 | User declares                              | Meaning |
|------------------|--------------------------------|--------------------------------------------|---------|
| REST             | `api.rest`                     | `calls.<svc>: { via: rest, ops: [...] }`   | Synchronous request/response |
| gRPC             | `api.grpc`                     | `calls.<svc>: { via: grpc, ops: [...] }`   | Synchronous, typed |
| Event            | `publishes: [topic]` + catalog | `consumes.<topic>: { handler }`            | A fact that happened; fan-out |
| Command          | `accepts.<name>: { schema }` + catalog | `sends.<name>: { to: <svc> }`     | A request to do something; one receiver |
| Foreign outbound | `foreign.outbound`             | *(none)*                                   | Third-party API this service calls |
| Foreign inbound  | `foreign.inbound`              | *(none)*                                   | Webhooks, SFTP, or feeds arriving |

`calls` entries also accept: `timeout`, `retry: { attempts, backoff }`, `breaker: bool`, `fallback: fail | cached | default-value`.

---

## Event catalog (`contracts/events.yaml`)

```yaml
order.placed:
  owner: order-service
  version: 1
  key: orderId
  delivery: at-least-once
  retention: 7d
  schema: { orderId: uuid, kioskId: string, total: money, placedAt: timestamp }
```

---

## Command catalog (`contracts/commands.yaml`)

Same shape as events, with `receiver:` instead of `owner:`, and optional `replies: [event names]`.

---

## Persistence

```yaml
stores:
  orders:
    kind: relational          # relational | document | kv | cache | blob | search
    pattern: crud             # crud | event-sourced | append-only | read-only
    retention: 7y
    entities:
      Order: { id: uuid pk, status: "enum[placed, paid]", total: money }
```

The basecamp maps `kind` to an engine. Ownership is exclusive (ARCH-001). A `cache` store may declare `source: <event>` to show it is fed by another service's events.

---

## Type shorthand

Used in entity maps, event schemas, command schemas, and API `in`/`out` shapes.

| Syntax              | Meaning |
|---------------------|---------|
| `uuid`              | UUID (string) |
| `string`            | Unbounded string |
| `string(n)`         | String max length n |
| `int`               | Integer |
| `decimal(p,s)`      | Fixed-point decimal |
| `bool`              | Boolean |
| `timestamp`         | ISO-8601 datetime |
| `date`              | ISO-8601 date |
| `money`             | `{ amount: decimal(19,4), currency: string(3) }` |
| `type?`             | Optional |
| `enum[a, b]`        | Closed set |
| `list<T>`           | Ordered list of T |
| `map<string, T>`    | Map of string to T |
| `TypeName`          | Named type from `contracts/types.yaml` |

**Modifiers** (space-separated after the base type): `pk`, `fk(Entity)`, `index`, `unique`, `min(n)`, `max(n)`, `cascade`

---

## Service file

```yaml
service: order-service
archetype: http
domain: ordering
purpose: Owns customer orders from kiosk checkout through payment and handoff to fulfillment.
# stack: spring-boot     # optional override; must be in basecamp.stacks

api:
  rest:
    POST /orders:          { in: PlaceOrder, out: Order, status: 201, desc: Place an order }
    GET /orders/{orderId}: { out: Order }

calls:
  catalog-service: { via: rest, ops: [GET /products/{sku}], timeout: 2s, retry: { attempts: 2 }, fallback: fail }

sends:
  payment.charge: { to: payment-provider }

publishes: [order.placed, order.paid]

consumes:
  payment.settled: { handler: markPaid }

stores:
  orders:
    kind: relational
    pattern: crud
    entities:
      Order: { id: uuid pk, status: "enum[placed, paid, cancelled]", total: money }

deviations:
  ARCH-010:
    reason: Price must be authoritative at checkout; a cached price could be minutes stale.
    scope: calls.catalog-service
```

---

## ecosystem.yaml

```yaml
ecosystem: kiosk-commerce
extends: everest-basecamp@1.0
description: Customers order at self-service kiosks.
domains:
  ordering: Orders from cart to handoff
  payments: Card charges and their outcomes
profiles:
  dev:  { mocks: true,  replicas: 1 }
  prod: { mocks: false, replicas: 2 }
```

---

## Rules

| ID        | Check                                                                                    | Enforcement         |
|-----------|------------------------------------------------------------------------------------------|---------------------|
| ARCH-001  | No store is owned by more than one service                                               | locked              |
| ARCH-010  | Calls between services in different domains must be async; gateway exempt                | default             |
| ARCH-020  | provider and adaptor have no domain stores (only kv/cache)                               | default             |
| EVT-001   | Each event has exactly one producer matching the catalog owner                           | locked              |
| EVT-002   | Every consumed event exists in the catalog                                               | locked              |
| CMD-001   | Each command has exactly one receiver matching the catalog and its accepts               | locked              |
| CMD-002   | Every sent command exists in the catalog                                                 | locked              |
| PERS-003  | A service that writes a store and publishes events gets `consistency: outbox` (derived)  | default             |
| NAME-001  | Archetype naming suffixes on id (`-provider`, `-adaptor`)                                | default, auto-fixable |
| DEP-001   | No cycles in synchronous calls                                                           | locked              |
| COMM-001  | Every edge uses a mode both archetypes allow; calls.ops exist in the target's api        | locked              |
| REF-001   | Every service, domain, type, and handler referenced exists                               | locked              |

### Enforcement levels

- **locked** — a violation is an error; deviations are not allowed.
- **default** — a violation is an error unless the service has a matching `deviations.<rule-id>` entry with a reason. With one, it is reported as an accepted deviation (warning).
- **advisory** — a warning only.

NAME-001 is auto-fixable: the resolver reports the suggested fix. The fix is applied as an ordinary patch the chat proposes, never silently.

---

## Provenance annotations

The CLI and `/api/ecosystems/:name/effective/:service` (Accept: text/plain) render effective specs with trailing comments showing the source of each value:

```yaml
runtime:
  port: 3000    # ← stack:node-express
  framework: express  # ← stack:node-express
consistency: outbox   # ← derived:PERS-003
```

Sources: `basecamp`, `archetype:<name>`, `stack:<name>`, `ecosystem`, `service`, `profile:<name>`, `derived:<rule-id>`.
