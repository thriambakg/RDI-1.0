# User Profiles Table — Schema

## Overview

Stores per-user profile data including connection hierarchy (folder organization for sessions).

**Table:** `user-profiles` (RDI-Base-Infra)

## Base table

| Key / Attribute | Type | Notes |
|-----------------|------|-------|
| **PK** | `user_id` (S) | Cognito sub — primary key |
| `email` | S | User email (optional) |
| `connection_hierarchy` | M or S | Folder hierarchy; see below. Stored as DynamoDB Map or JSON string. |

## GSIs

| Name | PK | SK | Purpose |
|------|-----|-----|---------|
| `email-index` | `email` | — | Lookup user by email |

---

## connection_hierarchy

Maps folder names to folder objects. Each folder contains `sessions` (array of `{session_id, name, status}`) and `subfolders` (nested folders). Supports arbitrary nesting.

**DynamoDB storage:** Map (M) for partial updates. DynamoDB types: Map for folders, List for sessions, Map for each session entry.

**Structure (logical):**

```json
{
  "My Drones": {
    "sessions": [
      { "session_id": "sess-uuid-1", "name": "Chicago-Test", "status": "idle" }
    ],
    "subfolders": {
      "Fleet A": {
        "sessions": [],
        "subfolders": {}
      }
    }
  },
  "Shared": {
    "sessions": [],
    "subfolders": {}
  }
}
```

### Folder object

| Key | Type | Notes |
|-----|------|-------|
| `sessions` | Array | Each element: `{ "session_id": string, "name": string, "status": "active" \| "idle" }` |
| `subfolders` | Object | Map of folder name → folder object (recursive) |

### Session entry (in folder)

| Field | Type | Notes |
|-------|------|-------|
| `session_id` | string | References connection pool table |
| `name` | string | Display name (from drone_id prefix) |
| `status` | string | `active` \| `idle` |

### Default folders

| Folder | Default | Deletable |
|--------|---------|-----------|
| **My Drones** | Yes | Yes |
| **Shared** | Yes | Yes |

### Rules

- New users get `{"My Drones": {sessions: [], subfolders: {}}, "Shared": {sessions: [], subfolders: {}}}`.
- Folders are deletable; deleting a folder moves its sessions to uncategorized (or drops refs — sessions remain in connection pool).
- A `session_id` appears in at most one folder (or none).
- Session create → add to "My Drones" (or specified folder). Session delete → remove from hierarchy. Session release (idle) → update status in hierarchy.
- Full session details (endpoint, expires_at, etc.) are fetched on demand from the connection pool when the user views a connection.

---

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/user-profile` | Return user profile including `connection_hierarchy` (folders) |
| PATCH | `/user-profile` | Update `connection_hierarchy` |

### PATCH actions

| Action | Body | Purpose |
|--------|------|---------|
| `create_folder` | `{ parent_path: string[], folder_name: string }` | Create a new folder inside `parent_path` (use `[]` for root) |
| `delete_folder` | `{ folder_path: string[] }` | Delete a folder and its refs (sessions become uncategorized) |

---

## Query patterns

| Pattern | How |
|---------|-----|
| Get user profile | GetItem(PK=user_id) |
| Update connection hierarchy | UpdateItem(PK=user_id, SET connection_hierarchy = :val) |
| Lookup user by email | Query(email-index, PK=email) |
