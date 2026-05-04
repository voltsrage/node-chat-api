# Phase 22 — Full-Text Message Search

## What exists

From Phase 21:
- `src/models/Message.js` — Message schema with `content`, `roomId`, `senderId`, `senderUsername`, `type`, `reactions`, `editedAt`, `deletedAt`; no text index
- `src/services/messageService.js` — `createMessage`, `editMessage`, `deleteMessage`, `getMessageHistory`, `toggleReaction`; `toMessageResponse` helper
- `src/controllers/messageController.js` — `getMessageHistory`
- `src/routes/rooms.js` — `GET /:id/messages` route protected by `requireMember`

## What needs to be built

Four steps. One concept worth understanding before writing code:

**What MongoDB text search can and cannot do:**

| Capability | Supported |
|---|---|
| Full-word matching with stemming ("running" → "run") | Yes |
| Case-insensitive matching | Yes |
| Exact phrase matching (`"hello world"` in quotes) | Yes |
| Negation (`-word` to exclude) | Yes |
| Relevance scoring | Yes |
| Prefix / substring matching ("hel" → "hello") | No |
| Fuzzy / typo-tolerant matching ("helo" → "hello") | No |
| Regex matching | No (use separate scan) |

This is the decision boundary: MongoDB text search is appropriate when users type whole words. If the product needs autocomplete, typo tolerance, or cross-field relevance ranking, the correct tool is Elasticsearch or OpenSearch.

---

## Step 1 — Text index on Message schema

**`src/models/Message.js`** — add a text index on `content`:

```js
messageSchema.index({ content: 'text' });
```

**What this does:**

MongoDB tokenizes the `content` string, applies a language-specific stemmer (default: English), and writes each stem to the inverted index. A query for `"running"` matches documents containing `"run"`, `"runs"`, or `"running"` because they share the same stem.

**MongoDB allows only one text index per collection.** If you need to search across multiple fields (e.g., `content` and `senderUsername`), combine them in a single compound text index:

```js
// Compound text index — search content and senderUsername in one query
messageSchema.index({ content: 'text', senderUsername: 'text' });
```

For this phase, content-only is sufficient.

**Why not a regular index on `content`:**

A regular `{ content: 1 }` index supports exact equality and range queries — not full-word search. Text search requires the tokenized inverted index that only `{ content: 'text' }` creates.

**Compound with `roomId` for bounded searches:**

The search is always scoped to a single room. Adding `roomId` to the index doesn't help here — MongoDB text indexes cannot be compound with regular ascending/descending fields in a way that restricts the scan scope. The text index scans all matching documents across the collection, then the `roomId` filter is applied as a post-scan condition. For large deployments, a dedicated search service scoped to the room partition would be more efficient.

---

## Step 2 — Search service function

**`src/services/messageService.js`** — add `searchMessages`:

```js
export async function searchMessages(roomId, query, { page, pageSize, skip }) {
  if (!query?.trim()) {
    throw new ValidationError('Search query is required.', 'MISSING_QUERY');
  }

  // Truncate to a reasonable length — text queries with thousands of words are
  // not useful and generate unnecessarily large query plans
  const sanitized = query.trim().slice(0, 500);

  const filter = {
    roomId,
    deletedAt: null,          // never surface soft-deleted messages
    $text: { $search: sanitized },
  };

  const [messages, total] = await Promise.all([
    Message
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })   // most relevant first
      .skip(skip)
      .limit(pageSize)
      .lean(),
    Message.countDocuments(filter),
  ]);

  return paginatedResponse(
    messages.map(toMessageResponse),
    total,
    page,
    pageSize
  );
}
```

**The `$meta: 'textScore'` pattern — why it appears twice:**

Text score is a computed value, not a stored field. MongoDB makes it available only within the same query via `{ $meta: 'textScore' }`. It must appear in both the projection (to include it in the returned document) and the sort (to sort by it). Omitting it from the projection but using it in sort, or vice versa, produces a query error.

**Why `countDocuments` with `$text` is acceptable:**

`countDocuments({ $text: { $search } })` uses the text index and returns quickly. It does not re-scan the collection.

**Why offset pagination (skip/limit) instead of cursor-based:**

Cursor-based pagination uses a stable cursor field (e.g., `_id` or `createdAt`) to page forward efficiently. Text score is not stable — the same document has different scores in different queries. There is no meaningful cursor to bookmark a position in a relevance-ranked result set. Skip/limit is the correct choice for search results.

The trade-off: deep pages (`skip(10000)`) with large collections are slow because MongoDB must score and discard the skipped documents. In practice, users rarely paginate search results past page 5 — this is an acceptable trade-off for the complexity saved.

---

## Step 3 — Controller handler

**`src/controllers/messageController.js`** — add `searchMessages`:

```js
import * as messageService from '../services/messageService.js';
import * as unreadService  from '../services/unreadService.js';
import { ApiResponse }     from '../utils/ApiResponse.js';
import { parsePaginationQuery } from '../utils/pagination.js';

export async function searchMessages(req, res) {
  const { q } = req.query;
  const pagination = parsePaginationQuery(req.query);
  const result = await messageService.searchMessages(req.params.id, q, pagination);
  res.json(ApiResponse.success(result));
}
```

**No `resetUnread` here:**

`getMessageHistory` resets the unread counter because fetching history implies reading all messages in the room. A search query does not imply the user has read everything — they may only care about the one result they found. No unread reset on search.

---

## Step 4 — Route

**`src/routes/rooms.js`** — add the search route:

```js
// GET /:id/messages/search must be registered BEFORE any /:id/messages/:messageId route.
// Without this ordering, a future route like GET /:id/messages/:messageId would
// capture "search" as the :messageId parameter.
// GET /:id/messages (the existing history route) does NOT conflict — it is a shorter
// exact path and Express resolves these correctly without ordering constraints.
roomsRouter.get('/:id/messages/search', requireMember, messageController.searchMessages);

// Existing history route — unchanged
roomsRouter.get('/:id/messages',        requireMember, messageController.getMessageHistory);
```

**Route order note:**

`GET /:id/messages` and `GET /:id/messages/search` are different path lengths. Express matches them correctly regardless of registration order because neither contains a wildcard parameter at the conflicting segment. The ordering comment above is a forward-looking guard: if `GET /:id/messages/:messageId` is added later (e.g., for fetching a single message by ID), it must be registered AFTER `/:id/messages/search` to prevent "search" being captured as `:messageId`.

---

## Verification

**1. Index created — confirm in mongosh:**

```js
db.messages.getIndexes()
// Expected: one index entry with key: { _fts: "text", _ftsx: -1 }
// and weights: { content: 1 }
```

**2. Basic search — returns relevant results:**

```bash
# Alice and Bob have exchanged messages. Some contain "deployment", some do not.
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages/search?q=deployment" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.items[].content'
# Expected: only messages containing "deployment" (or its stemmed form)
```

**3. Stemming — searching "deploy" matches "deployment":**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages/search?q=deploy" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.items[].content'
# Expected: messages with "deployment", "deployed", "deploy" all appear
```

**4. Soft-deleted messages are excluded:**

```bash
# Delete a message that contains "deployment" via socket
socket.emit('message:delete', { messageId: DELETED_ID });

# Search should not return the deleted message
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages/search?q=deployment" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '[.data.items[].id]'
# Expected: DELETED_ID is absent
```

**5. Non-member cannot search a private room:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$PRIVATE_ROOM/messages/search?q=secret" \
  -H "Authorization: Bearer $NON_MEMBER_TOKEN"
# Expected: 403 NOT_MEMBER — requireMember fires before the handler
```

**6. Empty query rejected:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages/search" \
  -H "Authorization: Bearer $ALICE_TOKEN"
# Expected: 422 MISSING_QUERY

curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages/search?q=%20%20" \
  -H "Authorization: Bearer $ALICE_TOKEN"
# Expected: 422 MISSING_QUERY  (whitespace-only trimmed to empty)
```

**7. Pagination — results split across pages:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages/search?q=deployment&page=1&pageSize=5" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data | {total, page, pageSize, itemCount: (.items | length)}'
# Expected: { total: <N>, page: 1, pageSize: 5, itemCount: 5 }  (assuming N > 5)
```

**8. Verify index is used — `.explain()` in mongosh:**

```js
db.messages.find(
  { roomId: ObjectId('<id>'), deletedAt: null, $text: { $search: 'deployment' } },
  { score: { $meta: 'textScore' } }
).explain('executionStats')

// Look for in the output:
// winningPlan.stage === "FETCH"
// winningPlan.inputStage.stage === "TEXT_MATCH"
// winningPlan.inputStage.inputStage.stage === "IXSCAN"
//
// executionStats.totalDocsExamined should be << collection size
// (only matching documents are examined, not the full collection)
```

**9. Phrase search — exact phrase matching:**

```bash
# Send a message: "the quick brown fox"
# Search for the exact phrase
curl -s 'http://localhost:3000/api/v1/rooms/$ROOM/messages/search?q=%22quick+brown%22' \
  -H "Authorization: Bearer $ALICE_TOKEN"
# Expected: returns "the quick brown fox" message
# A search for q=%22quick+fox%22 would NOT match (non-adjacent words)
```

**10. Cross-room isolation — results scoped to the requested room:**

```bash
# Message "deployment complete" exists in ROOM_A but not ROOM_B
curl -s "http://localhost:3000/api/v1/rooms/$ROOM_B/messages/search?q=deployment" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.total'
# Expected: 0 — roomId filter isolates results to the queried room
```

---

## File map

| File | Status |
|---|---|
| `src/models/Message.js` | Updated — `messageSchema.index({ content: 'text' })` |
| `src/services/messageService.js` | Updated — add `searchMessages(roomId, query, pagination)` |
| `src/controllers/messageController.js` | Updated — add `searchMessages` handler |
| `src/routes/rooms.js` | Updated — `GET /:id/messages/search` before `GET /:id/messages` |

---

## Checklist

- [ ] Step 1 — `messageSchema.index({ content: 'text' })` — only one text index per collection
- [ ] Step 1 — Can explain what the text index stores (stemmed tokens in inverted index)
- [ ] Step 1 — Can explain why a regular `{ content: 1 }` index does not support text search
- [ ] Step 2 — `filter` includes `roomId` and `deletedAt: null` — scoped, no deleted messages
- [ ] Step 2 — `{ $meta: 'textScore' }` appears in both the projection and the sort — can explain why both are required
- [ ] Step 2 — `countDocuments` uses the text index — no full collection scan for total count
- [ ] Step 2 — Query length capped at 500 characters — can explain why unbounded input is a concern
- [ ] Step 2 — Offset pagination (skip/limit) chosen over cursor — can explain why text score makes cursor pagination impractical
- [ ] Step 3 — `searchMessages` controller does NOT call `resetUnread` — can explain why
- [ ] Step 4 — `/:id/messages/search` registered before any future `/:id/messages/:messageId` route
- [ ] Verification — `getIndexes()` shows text index with `_fts: "text"`
- [ ] Verification — Stemming confirmed: search for "deploy" returns messages with "deployment"
- [ ] Verification — Soft-deleted messages absent from search results
- [ ] Verification — `.explain()` shows `IXSCAN` on the text index, not `COLLSCAN`
- [ ] Verification — Cross-room isolation: search in room B does not return results from room A
- [ ] Knowledge check — Can explain the two cases where MongoDB text search is insufficient and Elasticsearch is the right choice (prefix/substring search, typo tolerance)
- [ ] Knowledge check — Can explain why compound text + roomId index does not scope the index scan to one room
- [ ] Knowledge check — Can explain MongoDB text search query syntax: multi-term OR, quoted phrases, negation with `-`
