# Decision: audit writes, outbox and a message queue

Raised in Prompt 50 (2026-11-18 15:01 IST): *"if the audit log is expecting a large amount of writes we can implement a message queue for asynchronous event streaming … and if an outbox table is required … if somehow the message queue goes down."*

Status: **decided: Option A** (Prompt 51). Keep the in-transaction audit; the triggers in section 5 decide when to move to B or C.

---

## 1. What the system does today

| Flow | How it is written | Guarantee |
|---|---|---|
| **Audit log** | `app.audit()` inside the same DB transaction as the change; hash-chained per org under a per-org lock | An entry exists **if and only if** the change committed. No loss, no phantom entries. |
| **Webhooks** | A delivery row is written in the same transaction as the change (**transactional outbox**, already built); a worker claims rows with `FOR UPDATE SKIP LOCKED` | An event is never lost and never sent for a rolled-back change. At-least-once delivery (receivers dedupe on `webhook-id`). |
| **Real-time** | Socket.IO through the Postgres adapter (`NOTIFY`) | Best-effort live updates; every client re-reads from the DB, so a missed event only means a later refresh. |

## 2. Measured capacity (not estimated)

A benchmark of `app.audit()` on this machine (Postgres 18, local), all writes in **one** organization, so all of them contend for the same chain lock (the worst case):

| Concurrency | Throughput | Time per write |
|---|---|---|
| 1 | **1,984 writes/s** | 0.50 ms |
| 10 | **3,236 writes/s** | 3.1 ms (includes queueing behind the lock) |

Different organizations don't share a lock, so capacity grows with the number of orgs.

## 3. Expected load at this project's scale

What creates audit rows: sign-ins, every write, opening a dashboard, viewing members or the audit log, refused requests, and failed webhook attempts. Metric ticks and chart polling create **none**.

| Scenario (one org) | Audited actions | Share of measured capacity |
|---|---|---|
| Assessment demo: 5–20 users | < 1 /s | < 0.1% |
| Busy company org: 500 active users, one audited action each per 10 s | ~50 /s | ~1.5% |
| Extreme: 5,000 active users, one each per 5 s | ~1,000 /s | ~30% |

**Conclusion:** Even an org 100× larger than the demo uses a small fraction of what Postgres already does synchronously. A message queue would not relieve a real bottleneck at this scale.

## 4. The options

### Option A: keep in-transaction audit (today)
- **Pros:**
  - strongest correctness: an entry is atomic with the change;
  - no new infrastructure;
  - nothing to lose if a component is down.
- **Cons:**
  - writes serialize per org (fine up to ~1,000+/s per org, measured above);
  - each audited request pays ~0.5 ms.

### Option B: Postgres audit outbox + async chainer
- **How it works:**
  - the request inserts a raw event row in its transaction, with no lock;
  - a background worker hash-chains the events into `audit_log` in order, in batches.
- **Pros:**
  - still atomic with the change and still no new infra;
  - the per-org lock leaves the request path;
  - batching raises throughput.
- **Cons:**
  - entries appear a moment later;
  - a second worker to run and monitor;
  - more code.

### Option C: message queue (Kafka, Redis Streams, RabbitMQ or SQS) fed by an outbox
- **The dual-write problem:** writing to the DB and to a broker separately can't be atomic. Sending inside the transaction can publish a change that rolls back; sending after the commit can be lost in a crash ([microservices.io, Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)).
  - So a queue **still needs an outbox table**. The event is committed with the change, and a relay forwards it to the broker.
- **If the queue goes down:**
  - with the outbox, requests keep working;
  - events wait safely in Postgres, and the relay retries until the broker is back;
  - without an outbox, events are lost or requests fail.
- **Pros:**
  - fan-out to many consumers (SIEM, analytics, data lake);
  - decoupled scaling.
- **Cons:**
  - new infrastructure on a single EC2 box (memory, ops, monitoring, backups);
  - at-least-once delivery, so consumers must be idempotent;
  - the audit chain still needs **one ordered consumer** per org;
  - more failure modes to run and test, for no current bottleneck.

## 5. Recommendation

**Option A now, with Option B → C as a documented, measured upgrade path.**

The webhook system already uses the outbox design, so the same relay pattern extends to a queue when it's needed. Trigger points, any of which justifies the next step:

| Signal | Move to |
|---|---|
| Sustained audit writes per org > ~1,000/s (about 30% of measured capacity), or p95 audit write > 5 ms | B |
| A second consumer of events appears (SIEM, analytics, another service), or several API regions | C (relay from the existing outbox tables) |
| Webhook backlog (oldest pending delivery) > 1 minute under normal load | Move the webhook worker to its own process (before any queue) |

If C is chosen later:
- keep the outbox, so a broker outage never loses events or blocks users;
- alert on outbox age;
- consumers dedupe on the event id.

## 6. Questions for the user

1. Option A now, with the documented upgrade path? Or build B, or C, now?
2. If C now: which broker? On a single EC2 box, Redis Streams is the lightest; Kafka is the heaviest.
