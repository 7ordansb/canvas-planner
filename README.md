# Canvas Planner

A task tracker that is a big canvas. Every task is a card you can drag anywhere. Cards **get bigger the longer they sit there** and as their **due date gets closer**, so the things you've been putting off become impossible to ignore. Ticking a card off shrinks it away.

It runs on Windows and macOS **without installing anything**.

## Get it
1. Go to the [latest GitHub release](https://github.com/7ordansb/canvas-planner/releases/latest).
2. Download your version:
   - **Windows (64-bit):** Download `CanvasPlanner.exe` and double-click it to launch. The app uses the Microsoft Edge WebView2 runtime included with Windows 11 and most Windows 10 PCs. [WebView2 runtime details](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)
   - **Mac:** `CanvasPlanner-mac.zip`. Unzip it and open **Canvas Planner.app**. The first time, approve it in **System Settings → Privacy & Security → Open Anyway**.
3. In the desktop app, choose **Settings → Update from GitHub** to get the latest release and restart. With older versions, download the latest release and replace the old app file once. Your tasks are stored separately.

## Using it
- Start on the **Dashboard** to create or open a canvas and see task totals, overdue tasks, and upcoming due dates. Boards created before the dashboard appear under **Original canvas**.
- **Double-click** empty space to add a note. **Drag** cards to move them. Drag empty space or scroll to move around. Pinch or Ctrl+scroll to zoom.
- Type directly on a new note or double-click an existing one to edit it. Press **Tab** to switch between its title and notes. Turn on **Task mode** in the side panel to enable a due date, completion and automatic growth. Use **Links and files** to attach a web link or file to that note.
- In task mode, use **Checklist** to add, edit, tick off, reorder, or delete subtasks. The card shows progress as completed/total. Checking the final subtask completes the task, and unchecking a subtask reopens it.
- Change **Note style** on a card or choose the default in Settings. Use **Document** to write and scroll through long text on the canvas, or choose **Import document…** in the add menu to read a plain-text or Markdown file there.
- Choose **Timer** from the add menu. Set a label and pick a stopwatch, a countdown in seconds, or a counter that changes by one every second.
- Set a card’s colour in the side panel or right-click menu. When a canvas uses multiple colours, use the toolbar to show or hide them.
- Hover near a card’s edge to find **+**. Click it to add a linked task, image, file, or sub-canvas. Drag from **+** onto another card to link them, and click the link label to change its type or remove it.
- Drop or paste files onto the canvas and double-click their cards to open them.
- Sub-canvas cards preview the layout inside. Click one to expand it, use the breadcrumb to go back, or drag a card onto a sub-canvas to move it inside. Press **/** to search across canvases.
- Right-click empty canvas space and choose **Label** to add text directly to the canvas. Drag the bottom-right corner of a note or label to resize it.
- Open **Settings** inside a canvas to change its task growth and default mode for new notes. These settings also apply to its sub-canvases. Dashboard Settings controls defaults for new canvases and provides backup and diagnostic tools.
- Press **?** for all keyboard shortcuts.

## Sync between computers (GitHub)
Click **Sync: not set up** in the toolbar and follow the steps (about 5 minutes). You need a free GitHub account and a private repo. Details: [docs/SYNC.md](docs/SYNC.md).

## Import tasks
Click **Import**. You can paste a list, load a CSV file, or sign in to Microsoft To Do. To Do needs a one-time setup; see [docs/IMPORT.md](docs/IMPORT.md).

## If something goes wrong
Click the **gear button → Copy diagnostics** and paste the result into a Claude chat opened in this project folder. [CLAUDE.md](CLAUDE.md) gives Claude the background it needs.
