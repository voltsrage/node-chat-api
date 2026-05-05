# Phase 22b — Elasticsearch Full-Text Message Search

## Context

Phase 22 implemented full-text search using MongoDB's built-in `$text` index. This phase replaces that implementation with Elasticsearch to gain capabilities the MongoDB text index cannot provide:

| Capability | MongoDB `$text` | Elasticsearch |
|---|---|---|
| Stemming ("running" → "run") | Yes | Yes |
| Case-insensitive | Yes | Yes |
| Phrase matching | Yes | Yes |
| Negation | Yes | Yes |
| Relevance scoring | Basic | BM25 (more accurate) |
| Fuzzy / typo-tolerant ("helo" → "hello") | No | Yes (`fuzziness: AUTO`) |
| Prefix / substring matching | No | Yes |
| Hit highlighting | No | Yes |
| Cross-field relevance ranking | Limited | Yes |
| Horizontal scale | Coupled to MongoDB | Independent |

The decision boundary: MongoDB text search is the right default when users type whole words and the dataset is small. Elasticsearch is correct when the product needs typo tolerance, hit highlighting, or the search corpus needs to scale independently of the primary database.

---

## What exists after Phase 22

- `src/models/Message.js` — `messageSchema.index({ content: 'text' })` (MongoDB text index — will be removed)
- `src/services/messageService.js` — `searchMessages` using `$text: { $search }` with `$meta: 'textScore'` scoring
- `src/controllers/messageController.js` — `searchMessages` handler (unchanged by this phase)
- `src/routes/rooms.js` — `GET /:id/messages/search` protected by `requireMember`

---

## Architecture

```
Client
  └── GET /rooms/:id/messages/search?q=...
        └── messageController.searchMessages
              └── messageService.searchMessages        ← validates + delegates
                    └── searchService.searchMessages   ← ES query

Socket events (message:send / message:edit / message:delete)
  └── messageService.createMessage / editMessage / deleteMessage
        └── searchService.indexMessage / updateMessageContent / markDeleted
              └── esClient  (fire-and-forget, non-blocking)
```

Write-through indexing: every Mongo write that mutates message content also updates the ES index. The ES write is fire-and-forget — if ES is unavailable, the Mongo write still succeeds and the message is delivered. Search may lag until ES recovers, but no data is lost.

---

## Step 1 — Install the client

```bash
npm install @elastic/elasticsearch
```

Adds the official `@elastic/elasticsearch` v8 client. The v8 client uses a request-body-as-top-level-args API (no nested `body:` wrapper), which is what all code in this phase uses.

---

## Step 2 — ES client + index setup

**New file: `src/db/elasticsearch.js`**

```js
import { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

export const INDEX = 'messages';

export const esClient = new Client({
    node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
    ...(process.env.ELASTICSEARCH_API_KEY && {
        auth: { apiKey: process.env.ELASTICSEARCH_API_KEY },
    }),
});

export async function connectES() {
    await esClient.ping();
    await ensureIndex();
    logger.info('Elasticsearch connected');
}

async function ensureIndex() {
    const exists = await esClient.indices.exists({ index: INDEX });
    if (exists) return;

    await esClient.indices.create({
        index: INDEX,
        mappings: {
            properties: {
                roomId:         { type: 'keyword' },
                senderId:       { type: 'keyword' },
                senderUsername: { type: 'keyword' },
                content:        { type: 'text', analyzer: 'english' },
                deleted:        { type: 'boolean' },
                createdAt:      { type: 'date' },
            },
        },
    });

    logger.info({ index: INDEX }, 'Elasticsearch index created');
}
```

**Why `keyword` for IDs:**

`keyword` fields are stored as-is and support exact `term` queries. Using `text` on an ID would tokenize it, causing incorrect partial matches. Any field used only for filtering (not full-text search) should be `keyword`.

**Why `english` analyzer on `content`:**

The `english` analyzer applies lowercase normalization, stop-word removal, and the Porter stemmer. A query for "running" matches documents containing "run", "runs", or "running" — the same stemming behaviour as MongoDB's text index. Use `standard` instead to disable stemming for languages other than English, or configure per-language analyzers for multilingual deployments.

**Why `deleted: boolean` instead of storing `deletedAt`:**

Filtering on a nullable date in ES requires an `exists` query with a `must_not` clause. A plain boolean `term: { deleted: false }` filter is simpler and equally fast. The authoritative deleted state lives in MongoDB; ES only needs to know whether to surface the message in search results.

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Cluster endpoint |
| `ELASTICSEARCH_API_KEY` | — | API key auth (optional; omit for unauthenticated local dev) |

---

## Step 3 — Search service

**New file: `src/services/searchService.js`**

```js
import { esClient, INDEX } from '../db/elasticsearch.js';
import { paginatedResponse } from '../utils/paginate.js';

export function indexMessage(msg) {
    return esClient.index({
        index: INDEX,
        id: msg.id.toString(),
        document: {
            roomId:         msg.roomId.toString(),
            senderId:       msg.senderId.toString(),
            senderUsername: msg.senderUsername,
            content:        msg.content,
            deleted:        false,
            createdAt:      msg.createdAt,
        },
    });
}

export function updateMessageContent(id, content) {
    return esClient.update({
        index: INDEX,
        id: id.toString(),
        doc: { content },
    });
}

export function markDeleted(id) {
    return esClient.update({
        index: INDEX,
        id: id.toString(),
        doc: { deleted: true },
    });
}

export async function searchMessages(roomId, sanitized, { page, pageSize, skip }) {
    const response = await esClient.search({
        index: INDEX,
        from: skip,
        size: pageSize,
        query: {
            bool: {
                filter: [
                    { term: { roomId: roomId.toString() } },
                    { term: { deleted: false } },
                ],
                must: [
                    { match: { content: { query: sanitized, fuzziness: 'AUTO' } } },
                ],
            },
        },
        highlight: {
            fields: { content: {} },
        },
    });

    const { hits } = response;
    const total = typeof hits.total === 'number' ? hits.total : hits.total.value;

    const items = hits.hits.map(hit => ({
        id:             hit._id,
        roomId:         hit._source.roomId,
        senderId:       hit._source.senderId,
        senderUsername: hit._source.senderUsername,
        content:        hit._source.content,
        highlight:      hit.highlight?.content?.[0] ?? null,
        createdAt:      hit._source.createdAt,
    }));

    return paginatedResponse(items, total, page, pageSize);
}
```

**Why `bool` query with `filter` + `must`:**

ES `bool` queries have four clause types. The distinction between `filter` and `must` matters for scoring:

| Clause | Affects score | Cached |
|---|---|---|
| `filter` | No | Yes — ES caches bitsets for filter clauses |
| `must` | Yes | No |
| `should` | Yes | No |
| `must_not` | No | Yes |

`roomId` and `deleted` are hard constraints — they never affect relevance. Putting them in `filter` keeps them cached and excludes them from BM25 scoring. The `match` on `content` belongs in `must` because its score is the relevance ranking.

**Why `fuzziness: 'AUTO'`:**

`AUTO` maps edit distance to query length: 0 edits for terms ≤ 2 chars, 1 edit for 3–5 chars, 2 edits for 6+ chars. This catches common typos ("helo" → "hello", "depoyment" → "deployment") without being so lenient that short terms match unrelated words.

**Highlight:**

ES returns the matching excerpt with hit terms wrapped in `<em>` tags by default. The first fragment is taken (`[0]`). If ES returns no highlight for a hit (possible when the match is via fuzziness on a very short term), `null` is returned and the client falls back to displaying the raw `content`.

**Why offset pagination here (same reasoning as Phase 22):**

Relevance scores are not stable cursors — the same document has a different score in a different query. There is no meaningful field to bookmark a position in a relevance-ranked result set, so skip/limit is the correct choice. Users rarely paginate search results past page 5; deep-page performance is an acceptable trade-off.

---

## Step 4 — Wire indexing into messageService

**`src/services/messageService.js`** — three changes:

```js
// Add at top of file
import * as searchService from './searchService.js';
import { logger } from '../utils/logger.js';
```

**`createMessage`** — index after Mongo write:

```js
export async function createMessage(roomId, { senderId, senderUsername, content }) {
    const isMember = await Room.exists({ _id: roomId, memberIds: senderId });
    if (!isMember) {
        const err = new Error('NOT_MEMBER');
        err.code = 'NOT_MEMBER';
        throw err;
    }

    const message = await Message.create({
        roomId, senderId, senderUsername,
        content: content.trim(),
        type: 'text',
    });

    const response = toMessageResponse(message);
    searchService.indexMessage(response).catch(err =>
        logger.warn({ err }, 'ES index failed')
    );
    return response;
}
```

**`editMessage`** — update content in ES after Mongo update:

```js
    const response = toMessageResponse(message);
    searchService.updateMessageContent(messageId, response.content).catch(err =>
        logger.warn({ err }, 'ES update failed')
    );
    return response;
```

**`deleteMessage`** — mark deleted in ES after Mongo soft-delete:

```js
    searchService.markDeleted(messageId).catch(err =>
        logger.warn({ err }, 'ES delete failed')
    );
    return { id: message._id, roomId: message.roomId };
```

**`searchMessages`** — delegate to searchService:

```js
export async function searchMessages(roomId, query, pagination) {
    if (!query?.trim()) {
        throw new ValidationError('Search query is required.', 'MISSING_QUERY');
    }
    const sanitized = query.trim().slice(0, 500);
    return searchService.searchMessages(roomId, sanitized, pagination);
}
```

The controller (`messageController.searchMessages`) is unchanged — the swap is entirely inside the service layer.

---

## Step 5 — Startup wiring

**`src/index.js`** — call `connectES()` alongside `connectDB()`:

```js
import { connectES } from './db/elasticsearch.js';

async function start() {
    await connectDB();
    await connectES();   // add this line
    // ... rest unchanged
}
```

`connectES` throws if the cluster is unreachable or index creation fails, which causes `start()` to reject and the process to exit with code 1. This is intentional — a server that cannot reach its search backend should not accept traffic.

---

## Step 6 — Remove the MongoDB text index

**`src/models/Message.js`** — remove:

```js
// Remove this line:
messageSchema.index({ content: 'text' });
```

The MongoDB text index is no longer used. Keeping it wastes write overhead on every `Message.create` and `findOneAndUpdate`. Drop the index from the running collection after deploying:

```js
// Run once in mongosh after deploy
db.messages.dropIndex('content_text');
```

---

## Step 7 — Backfill existing messages

**New file: `src/scripts/backfill-search-index.js`**

Existing messages were indexed in MongoDB but not in ES. This script backfills them in batches.

```js
import 'dotenv/config';
import { connectDB } from '../db/connect.js';
import { connectES, esClient, INDEX } from '../db/elasticsearch.js';
import { Message } from '../models/Message.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 500;

async function run() {
    await connectDB();
    await connectES();

    let processed = 0;
    let skip = 0;

    while (true) {
        const batch = await Message.find({ deletedAt: null })
            .skip(skip)
            .limit(BATCH_SIZE)
            .lean();

        if (!batch.length) break;

        const operations = batch.flatMap(msg => [
            { index: { _index: INDEX, _id: msg._id.toString() } },
            {
                roomId:         msg.roomId.toString(),
                senderId:       msg.senderId.toString(),
                senderUsername: msg.senderUsername,
                content:        msg.content,
                deleted:        false,
                createdAt:      msg.createdAt,
            },
        ]);

        const { errors, items } = await esClient.bulk({ operations });
        if (errors) {
            const failed = items.filter(i => i.index?.error);
            logger.error({ count: failed.length }, 'Bulk index errors');
        }

        processed += batch.length;
        skip += BATCH_SIZE;
        logger.info({ processed }, 'Backfill progress');
    }

    logger.info({ processed }, 'Backfill complete');
    process.exit(0);
}

run().catch(err => {
    logger.error(err, 'Backfill failed');
    process.exit(1);
});
```

**Why `bulk` instead of individual `index` calls:**

`esClient.bulk` sends all operations in a single HTTP request. Individual `index` calls would make one HTTP round-trip per message — prohibitively slow for any dataset larger than a few hundred messages. Bulk throughput is typically 10–50x higher.

**Why `deletedAt: null` in the Mongo query:**

Soft-deleted messages should not appear in search results. Filtering them out at backfill time avoids indexing them into ES and then immediately having to exclude them with `deleted: true`.

**Add to `package.json` scripts:**

```json
"search:backfill": "node src/scripts/backfill-search-index.js"
```

Run with `npm run search:backfill` after the first deploy.

---

## Step 8 — Update Swagger doc

**`src/routes/rooms.js`** — expand the search route doc to reflect the ES response shape (adds `highlight`):

```js
/**
 * @openapi
 * /rooms/{id}/messages/search:
 *   get:
 *     summary: Full-text search messages in a room
 *     description: >
 *       Searches non-deleted messages via Elasticsearch. Results are ranked by
 *       BM25 relevance score with fuzzy matching (AUTO fuzziness). The query is
 *       truncated to 500 characters.
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - name: q
 *         in: query
 *         required: true
 *         description: Search query — supports fuzzy matching (max 500 characters)
 *         schema: { type: string }
 *       - { name: page,     in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       '200':
 *         description: Paginated search results sorted by Elasticsearch relevance score
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:             { type: string }
 *                       roomId:         { type: string }
 *                       senderId:       { type: string }
 *                       senderUsername: { type: string }
 *                       content:        { type: string }
 *                       highlight:
 *                         type: string
 *                         nullable: true
 *                         description: Matched excerpt with <em> tags around hit terms, or null
 *                       createdAt:      { type: string, format: date-time }
 *                 total:      { type: integer }
 *                 page:       { type: integer }
 *                 pageSize:   { type: integer }
 *                 totalPages: { type: integer }
 *       '400': { description: Missing or empty search query }
 *       '403': { description: Not a member of this room }
 */
```

---

## File map

| File | Status |
|---|---|
| `src/db/elasticsearch.js` | New — client singleton, `connectES()`, `ensureIndex()` |
| `src/services/searchService.js` | New — `indexMessage`, `updateMessageContent`, `markDeleted`, `searchMessages` |
| `src/scripts/backfill-search-index.js` | New — one-shot bulk backfill of existing messages |
| `src/services/messageService.js` | Updated — fire-and-forget ES calls in write ops; delegate search to searchService |
| `src/index.js` | Updated — `await connectES()` in `start()` |
| `src/models/Message.js` | Updated — remove `messageSchema.index({ content: 'text' })` |
| `src/routes/rooms.js` | Updated — expanded Swagger doc with `highlight` field |
| `package.json` | Updated — `@elastic/elasticsearch` dependency; `search:backfill` script |

---

## Verification

**1. Cluster reachable:**

```bash
curl http://localhost:9200
# Expected: JSON with cluster_name, version, etc.
```

**2. Index created with correct mappings:**

```bash
curl http://localhost:9200/messages/_mapping | jq '.messages.mappings.properties'
# Expected: roomId (keyword), content (text, analyzer: english), deleted (boolean), etc.
```

**3. Basic search returns relevant results:**

```bash
curl -s "http://localhost:3090/api/v1/rooms/$ROOM/messages/search?q=deployment" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.items[].content'
```

**4. Fuzzy match — typo in query still returns results:**

```bash
curl -s "http://localhost:3090/api/v1/rooms/$ROOM/messages/search?q=depoyment" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.total'
# Expected: > 0 (AUTO fuzziness corrects the typo)
```

**5. Highlight field present on hits:**

```bash
curl -s "http://localhost:3090/api/v1/rooms/$ROOM/messages/search?q=deployment" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.items[0].highlight'
# Expected: string containing <em>deployment</em> (or null if match via fuzzy only)
```

**6. Soft-deleted messages excluded:**

```bash
# Delete a message via socket: socket.emit('message:delete', { messageId: ID })
curl -s "http://localhost:3090/api/v1/rooms/$ROOM/messages/search?q=deployment" \
  -H "Authorization: Bearer $TOKEN" | jq '[.data.items[].id]'
# Expected: deleted message ID absent
```

**7. Non-member blocked:**

```bash
curl -s "http://localhost:3090/api/v1/rooms/$ROOM/messages/search?q=secret" \
  -H "Authorization: Bearer $NON_MEMBER_TOKEN"
# Expected: 403
```

**8. Empty query rejected:**

```bash
curl -s "http://localhost:3090/api/v1/rooms/$ROOM/messages/search" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 422 MISSING_QUERY
```

**9. Backfill — existing messages searchable after running the script:**

```bash
npm run search:backfill
# Then verify a known message from before the deploy is returned by search
```

**10. ES down — messages still send:**

Stop the ES container, send a message via socket, confirm it is delivered to the room (the fire-and-forget `.catch` swallows the ES error; the socket handler does not error).

---

## Checklist

- [ ] Step 1 — `npm install @elastic/elasticsearch`
- [ ] Step 2 — `src/db/elasticsearch.js` created; `connectES` pings cluster and calls `ensureIndex`
- [ ] Step 2 — `ensureIndex` is idempotent — calling it on a running server with the index already present is a no-op
- [ ] Step 2 — Can explain why IDs use `keyword` and `content` uses `text`
- [ ] Step 2 — Can explain why `deleted` is a boolean and not a nullable date
- [ ] Step 3 — `src/services/searchService.js` created with all four exports
- [ ] Step 3 — Can explain why `roomId` and `deleted` are in `filter`, not `must`
- [ ] Step 3 — Can explain what `fuzziness: AUTO` does and when it does not help (very short terms)
- [ ] Step 3 — `highlight` is `null`-safe — missing highlight does not crash the response
- [ ] Step 4 — All three write paths (`createMessage`, `editMessage`, `deleteMessage`) fire-and-forget to ES
- [ ] Step 4 — Fire-and-forget uses `.catch(logger.warn)` — ES failure is logged but does not throw
- [ ] Step 4 — `messageController.searchMessages` is unchanged
- [ ] Step 5 — `connectES()` called in `start()` before `httpServer.listen`
- [ ] Step 6 — `messageSchema.index({ content: 'text' })` removed from `Message.js`
- [ ] Step 6 — `db.messages.dropIndex('content_text')` run in mongosh after deploy
- [ ] Step 7 — Backfill script runs to completion without bulk errors on dev dataset
- [ ] Step 7 — `npm run search:backfill` added to `package.json`
- [ ] Step 8 — Swagger doc updated; `highlight` field documented as nullable string
- [ ] Verification — fuzzy typo query returns results
- [ ] Verification — deleted message absent from search after socket delete
- [ ] Verification — ES outage does not break message send
- [ ] Knowledge check — Can explain BM25 vs MongoDB text score
- [ ] Knowledge check — Can explain the tradeoff of fire-and-forget ES writes (consistency vs availability)
- [ ] Knowledge check — Can explain why cursor pagination doesn't work for relevance-ranked results
