# TeamChatAPI — System Design Constraints

These constraints define the operating envelope for the TeamChatAPI. They exist to drive real design decisions: index choices, pagination strategies, rate limits, and storage trade-offs. In an interview, these numbers are what you cite when explaining *why* you made a particular design call.

---

## Scale Targets

| Dimension | Value | Rationale |
|---|---|---|
| Total registered users | 100,000 | Mid-size SaaS, single region |
| Concurrent active users | 10,000 | ~10% of registered at peak |
| Rooms per workspace | 500 max | Aligns with Slack's practical limits |
| Members per room | 500 max | Drives the `memberIds` array-vs-collection trade-off |
| Messages per room per day | 10,000 | Active engineering team, high-volume channel |
| Total messages stored | 500 million | 5 years of retention across all rooms |

---

## Throughput

| Operation | Target |
|---|---|
| Message writes | 5,000 msg/sec sustained, 20,000 msg/sec burst (60s) |
| Message reads (history) | 50,000 req/sec |
| WebSocket connections | 10,000 concurrent |
| REST API calls | 20,000 req/sec aggregate |

---

## Latency SLAs

| Operation | p50 | p99 |
|---|---|---|
| Send a message (write ack) | < 50 ms | < 200 ms |
| Load message history (50 msgs) | < 30 ms | < 100 ms |
| Deliver message via WebSocket | < 100 ms end-to-end | < 500 ms |
| Auth (login / token verify) | < 50 ms | < 150 ms |
| Room list for a user | < 20 ms | < 80 ms |

---

## Data Constraints

### Messages

| Constraint | Limit |
|---|---|
| Max message content length | 4,000 characters |
| Max messages returned per page | 50 |
| Cursor-based pagination only | No `skip` beyond page 3 |
| Soft-delete retention window | 30 days before hard delete |
| Message edit window | 15 minutes after send |

### Rooms

| Constraint | Limit |
|---|---|
| Max members per room | 500 |
| Max rooms per user | 100 |
| Max room name length | 80 characters |
| Max room description length | 500 characters |

### Users

| Constraint | Limit |
|---|---|
| Username length | 3–32 characters, alphanumeric + underscore |
| Password minimum length | 8 characters |
| Display name length | 1–64 characters |
| Avatar upload size | 2 MB max, JPEG/PNG/WebP only |
| Sessions per user | 5 concurrent (device limit) |

---

## Rate Limits

Applied per authenticated user unless noted.

| Endpoint / Action | Limit |
|---|---|
| POST /messages | 60 msg/min |
| POST /rooms | 10 rooms/hour |
| POST /auth/login | 10 attempts/15 min (per IP) |
| GET /rooms/:id/messages | 120 req/min |
| PATCH /messages/:id (edit) | 30 req/min |
| DELETE /messages/:id | 30 req/min |
| File/avatar upload | 20 uploads/hour |

Exceeding a limit returns `429 Too Many Requests` with a `Retry-After` header.

---

## Availability and Durability

| Requirement | Target |
|---|---|
| Uptime SLA | 99.9% (< 9 hours downtime/year) |
| Message durability | 99.999% (no data loss after write ack) |
| Planned maintenance window | Sundays 02:00–04:00 UTC |
| RTO (recovery time objective) | 1 hour |
| RPO (recovery point objective) | 5 minutes |

---

## Storage

| Data | Estimate |
|---|---|
| Average message size (with metadata) | ~500 bytes |
| 500M messages | ~250 GB |
| Indexes (estimated 40% overhead) | ~100 GB |
| User avatars / media | ~50 GB |
| Total projected storage (5 years) | ~400 GB |

---

## Security Constraints

| Constraint | Detail |
|---|---|
| Password hashing | bcrypt, cost factor 12 |
| Auth tokens | JWT, 15-min access token + 7-day refresh token |
| Token storage | Refresh tokens stored server-side (Redis), revocable |
| Transport | HTTPS/WSS only; HTTP connections redirected |
| Input sanitization | All user content HTML-escaped before storage |
| Room access | Users may only read/write rooms they are members of |

---

## Key Trade-off Decisions Driven by These Constraints

1. **`memberIds` array on Room** — the 500-member cap keeps the array small enough that a `$elemMatch` index scan stays fast. If the cap were 10,000+, a separate `RoomMembership` collection with `{ roomId, userId }` compound index would be required.

2. **`senderUsername` denormalized on Message** — at 50,000 read req/sec, a `$lookup`/`populate` on every message history fetch adds an unacceptable second round-trip. Denormalization is correct given high read volume and infrequent username changes.

3. **Cursor pagination, no deep `skip`** — at 500M messages, `skip(10000)` scans 10,000 index entries before returning 50. Cursor-based pagination (`createdAt < cursor`) scans exactly the 50 documents needed.

4. **Soft delete with 30-day window** — hard-deletes at write time would leave gaps in cursor-paginated history. Soft deletes (`deletedAt != null`) keep the timeline intact; a background job purges after 30 days.

5. **15-minute edit window** — prevents retroactive rewriting of conversation history while still allowing typo correction. Enforced at the service layer, not the schema.
