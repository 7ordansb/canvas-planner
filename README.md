# Canvas Planner

A task tracker that is a big canvas. Every task is a card you can drag anywhere. Cards **get bigger the longer they sit there** and as their **due date gets closer**, so the things you've been putting off become impossible to ignore. Ticking a card off shrinks it away.

It runs on Windows and macOS **without installing anything**.

## Get it
1. Go to the repo's **Releases** page, or the **Actions** tab → the latest green run → **Artifacts**.
2. Download your version:
   - **Windows:** `CanvasPlanner.exe`. Put it anywhere (e.g. Documents) and double-click it. If Windows says "protected your PC", click **More info → Run anyway**.
   - **Mac:** `CanvasPlanner-mac.zip`. Unzip it and open **Canvas Planner.app**. The first time, approve it in **System Settings → Privacy & Security → Open Anyway**.
3. To update, download the new version and replace the old file. Your tasks are stored separately, so they stay.

## Using it
- **Double-click** empty space to add a task. **Drag** cards to move them. Drag empty space or scroll to move around. Pinch or Ctrl+scroll to zoom.
- Type directly on a new task or double-click an existing task to edit it. Press **Tab** to switch between its title and notes. Use the side panel to set a due date and click the card’s circle to complete it.
- Set a card’s colour in the side panel or right-click menu. When a canvas uses multiple colours, use the toolbar to show or hide them.
- Hover near a card’s edge to find **+**. Click it to add a linked task, image, file, or sub-canvas. Drag from **+** onto another card to link them, and click the link label to change its type or remove it.
- Drop or paste files onto the canvas and double-click their cards to open them.
- Click a sub-canvas to open it, use the breadcrumb to go back, or drag a card onto a sub-canvas to move it inside. Press **/** to search across canvases.
- **Preview** slider: see how big your cards will be in the coming days.
- Press **?** for all keyboard shortcuts.

## Sync between computers (GitHub)
Click **Sync: not set up** in the toolbar and follow the steps (about 5 minutes). You need a free GitHub account and a private repo. Details: [docs/SYNC.md](docs/SYNC.md).

## Import tasks
Click **Import**. You can paste a list, load a CSV file, or sign in to Microsoft To Do. To Do needs a one-time setup; see [docs/IMPORT.md](docs/IMPORT.md).

## If something goes wrong
Click the **gear button → Copy diagnostics** and paste the result into a Claude chat opened in this project folder. [CLAUDE.md](CLAUDE.md) gives Claude the background it needs.
