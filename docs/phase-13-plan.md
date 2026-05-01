# Phase 13 — Git Hygiene

## What exists

From Phase 12:
- A GitLab repository with all application code
- `.gitlab-ci.yml` — lint → test → build → deploy pipeline
- `main` as the production branch

## What needs to be built

Five steps. Same workflow as the Fleet Telemetry API with one addition: a `SOCKET_EVENTS.md` file at the repository root, because Socket.io events are not part of the OpenAPI spec and would otherwise be undocumented.

---

## Step 1 — Branch and commit conventions

**Branch naming — three prefixes:**

| Prefix | When to use | Example |
|---|---|---|
| `feature/` | New functionality | `feature/phase-14-email-verification` |
| `fix/` | Bug correction | `fix/presence-multi-tab-guard` |
| `chore/` | No production code change | `chore/update-ioredis-v5` |

One branch per logical unit of work. A branch that touches auth, rooms, and CI config simultaneously is three branches that were not split.

**Commit message format — Conventional Commits:**

```
<type>(<optional scope>): <short summary in present tense>

<optional body — the WHY, not the WHAT>
```

Types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`

```bash
# Good
feat(auth): add refresh token rotation on every use
fix(presence): only call markOffline when last socket closes
test(rate-limiter): add per-IP isolation assertion
docs: add SOCKET_EVENTS.md

# Bad — describes what, not why; no type
"updated some files"
"fixed bug"
"wip"
```

**The commit body is for the WHY:**

```
fix(presence): only call markOffline when last socket closes

Without the userSockets guard, closing one browser tab removed
the user from all presence sets even when a second tab was still
connected. markOffline is now conditional on userSockets.has(userId)
being false after the socket is removed.
```

A future `git blame` reader sees the what in the diff. The body is the only place the why gets recorded.

---

## Step 2 — Rebase workflow

**Starting a branch:**

```bash
# Always branch from the latest main, not a stale local copy
git checkout main
git pull --ff-only origin main
git checkout -b feature/my-feature
```

`--ff-only` fails loudly if `main` has diverged from your local copy rather than silently creating a merge commit. It forces you to resolve the situation explicitly.

**Keeping a branch up to date:**

```bash
# Rebase your branch onto the current main — do NOT merge main into your branch
git fetch origin
git rebase origin/main

# If there are conflicts:
# 1. Resolve each conflicted file
# 2. git add <resolved-file>
# 3. git rebase --continue
# 4. Repeat until done
```

Merging `main` into your feature branch creates a merge commit that shows up in the final MR diff. Rebasing replays your commits on top of the current `main` tip — the branch history stays linear.

**Before opening an MR — final rebase and push:**

```bash
git fetch origin
git rebase origin/main        # Ensure your branch is up to date
git push origin feature/my-feature --force-with-lease
# --force-with-lease is safer than --force:
# it fails if the remote branch has commits you have not seen yet
```

**On main — why linear history matters:**

A linear `git log` reads like a changelog:

```
feat(reactions): add message reaction toggle
fix(presence): only call markOffline when last socket closes
feat(search): add full-text message search endpoint
fix(rate-limiter): use Lua script to prevent INCR+EXPIRE race
```

Non-linear history introduces merge commits:

```
Merge branch 'feature/reactions' into 'main'
feat(reactions): add message reaction toggle
Merge branch 'main' into 'feature/reactions'  ← noise
fix(presence): ...
```

Merge commits also make `git bisect` harder: bisect may land on a merge commit, which has no single logical change to test.

---

## Step 3 — Merge request template

GitLab picks up MR description templates from `.gitlab/merge_request_templates/`.

**`.gitlab/merge_request_templates/Default.md`:**

```markdown
## What

<!-- One sentence: what does this MR do? -->

## Why

<!-- Why is this change needed? Link to an issue, a bug report, or explain the motivation. -->

## How to test

<!-- Steps for the reviewer to verify the change works correctly. -->

- [ ] ...
- [ ] ...

## Checklist

- [ ] Tests added or updated
- [ ] `npm run lint` passes locally
- [ ] `npm test` passes locally
- [ ] No `console.log` left in production code
- [ ] `.env.example` updated if new env vars were added
```

**What makes a good MR description:**

- **What** is a one-liner so a reviewer immediately knows the scope
- **Why** explains the motivation — links to the bug, the PRD phase, or the user complaint
- **How to test** means the reviewer does not have to reverse-engineer how to exercise the change
- The checklist is self-enforced; the pipeline enforces lint and tests automatically

---

## Step 4 — Branch protection in GitLab

**Settings → Repository → Protected Branches:**

| Setting | Value |
|---|---|
| Branch | `main` |
| Allowed to push | No one (force CI/MR for all changes) |
| Allowed to merge | Maintainers |
| Require code owner approval | Optional (enable if team > 1) |

**Settings → Merge Requests:**

| Setting | Value | Reason |
|---|---|---|
| Merge method | Squash commits | One logical commit per MR on main; branch commits are internal detail |
| Pipelines must succeed | Enabled | No broken code merges to main |
| All discussions must be resolved | Enabled | No unacknowledged review comments |
| Delete source branch | Enabled (default) | Keeps the branch list clean |

**Why squash, not rebase merge:**

Squash condenses all commits on the branch into one commit on main. The branch commit history (WIP, fixups, "actually fix it this time") is irrelevant to the main log. The squashed commit message should follow Conventional Commits format and describe the full logical change.

Rebase merge is an alternative that preserves each branch commit on main — appropriate when every commit on the branch is already clean and meaningful. For most feature work, squash is simpler.

---

## Step 5 — SOCKET_EVENTS.md

OpenAPI documents all REST endpoints, but Socket.io events have no equivalent standard. `SOCKET_EVENTS.md` at the repository root is the contract for front-end developers and future maintainers.

**`SOCKET_EVENTS.md`:**

```markdown
# Socket.io Events

Authentication: all connections must pass a valid JWT in the handshake auth object:

```js
const socket = io(SERVER_URL, { auth: { token: '<access-token>' } });
```

---

## Client → Server

### `message:send`

Send a new message to a room.

**Payload:**
```json
{ "roomId": "<string>", "content": "<string>" }
```

**Server response:** broadcasts `message:new` to the room on success; emits `error` on failure.

**Error codes:** `INVALID_CONTENT`, `NOT_MEMBER`, `RATE_LIMITED`, `INTERNAL_ERROR`

---

### `message:edit`

Edit a message within the 15-minute edit window.

**Payload:**
```json
{ "messageId": "<string>", "content": "<string>" }
```

**Server response:** broadcasts `message:edit` to the room on success.

**Error codes:** `INVALID_CONTENT`, `EDIT_NOT_ALLOWED`, `INTERNAL_ERROR`

---

### `message:delete`

Soft-delete a message. Content is replaced with `[deleted]`.

**Payload:**
```json
{ "messageId": "<string>" }
```

**Server response:** broadcasts `message:delete` to the room on success.

**Error codes:** `DELETE_NOT_ALLOWED`, `INTERNAL_ERROR`

---

### `typing:start`

Notify the room that this user is typing. Sets a 3-second Redis TTL.

**Payload:**
```json
{ "roomId": "<string>" }
```

**Server response:** broadcasts `typing:update` to the room (excluding sender).

---

### `typing:stop`

Notify the room that this user stopped typing. Does not delete the Redis key — the 3-second TTL expires naturally.

**Payload:**
```json
{ "roomId": "<string>" }
```

**Server response:** broadcasts `typing:update` to the room (excluding sender).

---

## Server → Client

### `message:new`

A new message was sent to a room this socket is joined to.

**Payload:**
```json
{
  "id": "<string>",
  "roomId": "<string>",
  "senderId": "<string>",
  "senderUsername": "<string>",
  "content": "<string>",
  "type": "text",
  "editedAt": "<ISO string | null>",
  "deletedAt": "<ISO string | null>",
  "createdAt": "<ISO string>"
}
```

---

### `message:edit`

A message in a room this socket is joined to was edited.

**Payload:** same shape as `message:new`; `editedAt` is set.

---

### `message:delete`

A message was soft-deleted.

**Payload:**
```json
{ "messageId": "<string>", "roomId": "<string>" }
```

The client should replace the message content with `[deleted]` using `messageId`.

---

### `typing:update`

A user in a room started or stopped typing.

**Payload:**
```json
{
  "roomId": "<string>",
  "userId": "<string>",
  "username": "<string>",
  "typing": true
}
```

`typing: false` is broadcast immediately on `typing:stop`. If `typing:stop` is never sent (e.g., client crashes), the indicator clears after the 3-second Redis TTL — the client must handle this with a client-side timeout.

---

### `error`

An event handler encountered an error.

**Payload:**
```json
{ "code": "<string>" }
```

| Code | Meaning |
|---|---|
| `INVALID_CONTENT` | Empty or whitespace-only message content |
| `NOT_MEMBER` | Sender is not a member of the target room |
| `EDIT_NOT_ALLOWED` | Message not found, already deleted, or outside 15-minute edit window |
| `DELETE_NOT_ALLOWED` | Message not found, already deleted, or not owned by sender |
| `RATE_LIMITED` | Sender exceeded 30 messages per 60-second window |
| `INTERNAL_ERROR` | Unexpected server error |
```

---

## Verification

**1. Branch discipline — no direct pushes to main:**

```bash
# Attempt a direct push to main
git checkout main
echo "test" >> README.md
git commit -am "direct push test"
git push origin main
# Expected: rejected — "main is a protected branch"
```

**2. Pipeline blocks a merge on lint failure:**

```bash
# On a feature branch, introduce a lint error:
const unused = 'test';  # unused variable

# Open an MR — pipeline runs
# Expected: MR shows "Pipeline: failed"; merge button is disabled
```

**3. Squash commit message on merge:**

```bash
# After merging an MR, check main's log:
git log --oneline origin/main -5
# Expected: one clean commit per MR, no "Merge branch" or "WIP" commits
```

**4. Rebase produces no merge commits on the feature branch:**

```bash
git log --oneline feature/my-feature
# Expected: all commits are yours — no "Merge branch 'main'" entries
```

**5. SOCKET_EVENTS.md is accessible and up to date:**

```bash
# After merging any phase that adds a new socket event,
# the MR description checklist should include:
# - [ ] SOCKET_EVENTS.md updated if new events were added
```

---

## File map

| File | Status |
|---|---|
| `SOCKET_EVENTS.md` | New — documents all client → server and server → client events with payload shapes and error codes |
| `.gitlab/merge_request_templates/Default.md` | New — What / Why / How to test / Checklist |

GitLab branch protection and MR settings are configured in the UI — no files.

---

## Checklist

- [ ] Step 1 — All branches follow `feature/`, `fix/`, or `chore/` naming
- [ ] Step 1 — All commit messages follow Conventional Commits format (`feat:`, `fix:`, etc.)
- [ ] Step 1 — Commit body used when the WHY is non-obvious
- [ ] Step 2 — Feature branches created from latest `main` using `git pull --ff-only`
- [ ] Step 2 — Branches updated with `git rebase origin/main`, never `git merge main`
- [ ] Step 2 — `git push --force-with-lease` used after a rebase (not `--force`)
- [ ] Step 3 — `.gitlab/merge_request_templates/Default.md` committed to the repository
- [ ] Step 3 — Every MR opened with the What / Why / How to test template filled in
- [ ] Step 4 — `main` is a protected branch — direct pushes rejected
- [ ] Step 4 — "Pipelines must succeed" enabled — broken code cannot be merged
- [ ] Step 4 — "Squash commits" enabled — main log is one commit per MR
- [ ] Step 5 — `SOCKET_EVENTS.md` documents all six client → server events and five server → client events
- [ ] Step 5 — `SOCKET_EVENTS.md` includes payload shapes, error codes, and the typing indicator TTL behaviour note
- [ ] Verification — Direct push to main is rejected
- [ ] Verification — `git log --oneline main` shows no merge commits
- [ ] Knowledge check — Can explain why `--force-with-lease` is safer than `--force`
- [ ] Knowledge check — Can explain the difference between squash merge and rebase merge and when to use each
- [ ] Knowledge check — Can explain why `SOCKET_EVENTS.md` exists separately from the OpenAPI spec
