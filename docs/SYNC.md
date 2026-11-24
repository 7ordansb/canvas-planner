# Syncing your board with GitHub

Canvas Planner can keep your board in a private GitHub repository, so that the
same tasks show up on every computer you use (for example your work laptop and
your Mac at home). Nothing needs to be installed. The app talks to GitHub
directly over the internet.

## One-time setup (about 5 minutes)

### 1. Create a private repository for your data

1. Sign in at **github.com**.
2. Click **+** (top right), then **New repository**.
3. For the name, type `canvas-planner-data`.
4. Choose **Private**. This matters, because your tasks will be stored there.
5. Tick **Add a README file**. This gives the repository a `main` branch.
6. Click **Create repository**.

### 2. Create a token (a password just for this app)

The token lets Canvas Planner read and write that one repository and nothing else.

1. In Canvas Planner, click the **Sync** button in the toolbar, then **Open the token page**.
   You can also go to github.com → your picture → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Token name:** `Canvas Planner`.
3. **Expiration:** 1 year is a good choice. Put a reminder in your calendar to make a new one.
4. **Repository access:** choose **Only select repositories** and pick `canvas-planner-data`.
5. **Permissions → Repository permissions → Contents:** set it to **Read and write**.
   Leave everything else as it is. GitHub adds "Metadata: Read-only" by itself, which is fine.
6. Click **Generate token** and copy it (it starts with `github_pat_`).
   GitHub only shows it once.

### 3. Connect the app

1. Click the **Sync** button in the toolbar.
2. **Repository:** type `your-username/canvas-planner-data`. You can also paste the repository's web address.
3. Leave **Branch** as `main` and **File path** as `board.json`, unless you know you want something else.
4. Paste the token and click **Connect**.

The button should change to **Synced · just now**. Do the same on each computer.
You can reuse the same token, or make one per computer, which lets you turn one
computer off later without affecting the others.

> When a computer with an empty board connects to a repository that already
> has tasks, it simply downloads them. A new, empty computer never wipes out
> your existing tasks.

## When does it sync?

It syncs automatically:

- when the app starts,
- about 4 seconds after you change something,
- every 2 minutes,
- when you switch back to the app window, and
- whenever you click **Sync now**.

The toolbar button shows what's happening:

| Button says | Meaning |
|---|---|
| Sync: not set up | Sync isn't connected on this computer. |
| Synced · 2 min ago | Everything is up to date (as of that time). |
| Syncing… | Sync is talking to GitHub right now. |
| Offline (will retry) | GitHub couldn't be reached. Your changes are safe on this computer and will be sent later. |
| Synced · files pending | Tasks are synced, but some images or files didn't transfer yet. They'll be retried. |
| Sync error | Something needs your attention. Click the button to see what. |

## What happens if I change things on two computers?

Each task is handled on its own:

- **If you edited different tasks** on each computer, both changes are kept.
- **If you edited the same task** on both, the most recent edit wins for that
  whole task. The older edit to that task is replaced. (Every version is
  still in the repository's history on GitHub, so nothing is truly lost.)
- **If you deleted a task on one computer and edited it on the other:**
  whichever happened *later* wins. If you edited it after deleting it, the
  task comes back.
- **The stacking order of cards** (which card is on top) is kept separately
  on each computer.

Records of deleted tasks and links are kept for 60 days so every computer gets the
message, then cleaned up.

## Links, images and files

**Links** (the lines between cards) sync just like tasks: each link is handled
on its own, the most recent change wins (for example changing "Related" to
"Dependency"), and deleting a link on one computer deletes it everywhere unless
it was changed later on another. A link to a card that was deleted elsewhere
disappears with the card. The order links are drawn in stays per computer.

**Images and files** you put on the board are uploaded to the same repository,
in a folder called `attachments` next to the board file (`attachments/` for
`board.json`, or `sub/attachments/` if the file path is `sub/board.json`).
Each file gets a unique name and never changes, so files can't conflict. After
each board sync:

- files used on the board that are on this computer but not on GitHub are uploaded
  (one commit per file, called `Add attachment`);
- files used on the board that are on GitHub but not on this computer are downloaded,
  and the picture appears as soon as it arrives.

The button shows progress ("Syncing files 2/5…"). If a file fails, your tasks
are still synced; the button says **Synced · files pending**, you get one
message, and the file is tried again on the next sync.

Size limits: the app accepts files up to 20 MB. Sync won't upload anything
over 50 MB (that file stays on that computer only, and you get one message
about it).

**Deleted images and files stay in the repository.** When you remove an image
from the board, its file is left in the `attachments` folder on GitHub, and
even if you delete it there by hand it remains in the repository's history.
Keep this in mind before adding anything sensitive.

Sync compares the clocks on your computers, so make sure each computer's
date and time are set correctly (they almost always are).

## What is stored where?

| What | Where |
|---|---|
| Your board (tasks, notes, due dates, links) | On each computer, and in `board.json` in your GitHub repository |
| Images and files on the board | In the app's data folder on each computer, and in `attachments/` next to `board.json` in the repository |
| The GitHub token | In your computer's secure keychain (Windows Credential Manager or the macOS Keychain). It is **not** in the board file or in GitHub. |
| Repository name, branch, file path, last sync time | In this app's settings on each computer |

Each sync that changes something creates a commit called
`Update board (Windows)` or `Update board (macOS)`. Nothing personal is added to the commit.

## Disconnecting

Click the Sync button, then **Disconnect**. This removes the token from this
computer. Your board stays on this computer and on GitHub. To fully revoke
access, also delete the token on GitHub (Settings → Developer settings →
Fine-grained tokens).

## Troubleshooting

**"Token rejected or expired"**
The token has expired, was deleted, or was pasted incorrectly. Make a new
token (step 2), paste it into the sync settings and click **Connect**.

**"Token lacks Contents write permission"**
The token can see the repository but can't save to it. Edit the token on
GitHub (or make a new one) and set **Repository permissions → Contents** to
**Read and write**. If the repository belongs to an organisation, an
organisation admin may need to approve the token.

**"Repo not found, or token can't see it"**
Check the spelling of `owner/name`. Also check that, when you created the
token, you chose **Only select repositories** and ticked this repository.
GitHub reports a repository it won't let you see as "not found".

**"Branch "…" not found"**
The branch name in the settings doesn't exist in the repository. Use `main`
unless you created another branch on purpose.

**"The file "board.json" on GitHub isn't a valid board"**
The file on GitHub was edited by hand and can no longer be read. To protect
your data, the app won't overwrite it. Fix or delete the file on GitHub (its
history lets you restore an older version), or pick a different **File path**.

**"Offline (will retry)"** stays for a long time
The computer can't reach `api.github.com`. Check your internet connection.
On a work network, the company firewall or proxy may be blocking GitHub; ask IT
whether `api.github.com` is allowed. Your changes are kept on this computer in
the meantime.

**"GitHub rate limit reached" / "GitHub is having trouble"**
GitHub is temporarily refusing or failing requests. Nothing to do; it will try
again by itself.

**"The file kept changing on GitHub"**
Several computers were saving at the same moment. It sorts itself out on the
next try.
