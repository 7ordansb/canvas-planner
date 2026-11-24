# Phase 0: testing on your work laptop

The goal is to find out, before we build the real app, whether your work laptop will:

1. run a portable app (no install),
2. reach GitHub (for sync), and
3. reach Microsoft (for the To Do import).

You'll need about 10 minutes.

---

## Step 1: Get the build (done on your Mac, once)

GitHub builds both versions automatically whenever code is pushed to the repo.

1. Open the repo on github.com and go to the **Actions** tab.
2. Click the latest **"Build portable apps"** run. Wait for it to turn green (about 10 minutes the first time).
3. At the bottom, under **Artifacts**, you'll see:
   - `Phase0Check-windows`: contains `Phase0Check.exe`
   - `Phase0Check-mac`: contains `Phase0Check-mac.zip`

## Step 2: Get it onto the work laptop

Use whichever of these is normal for you:

- **Easiest:** on the work laptop, sign in to github.com in the browser and download the artifact from the same Actions page.
- Or download it on your Mac and move it over on a USB stick, OneDrive, email to yourself, etc.

> Note what happens during the download. If the browser or email system **blocks a `.exe` or `.zip`**, that's our first finding.

## Step 3: Run it

### If the work laptop is Windows

1. Right-click the downloaded `Phase0Check-windows.zip` and choose **Extract All…**. Extract it somewhere you own, such as **Desktop** or **Documents**.
2. Double-click `Phase0Check.exe`.
3. A blue **"Windows protected your PC"** box (SmartScreen) is expected. Click **More info**, then **Run anyway**.
   - If there's **no "Run anyway" button**, your company has locked this down. Note it and skip to Step 5.
4. You might instead see something like **"This app has been blocked by your system administrator"** or **"Your organization used Device Guard / App Control to block this app."** That's corporate app blocking (AppLocker/WDAC). Note the exact wording.
5. You might see a message about **WebView2 Runtime** missing. That's rare on Windows 10/11, but note it if it appears.

### If the work laptop is a Mac

1. Double-click `Phase0Check-mac.zip` to unzip it. You'll get **Phase 0 Check.app**.
2. Double-click it. macOS will say it **can't be opened / can't verify the developer**.
3. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "Phase 0 Check". (On older macOS you can instead right-click the app → **Open** → **Open**.)
   - If there's no "Open Anyway" option, or it says the app is managed by your organization, note that.

## Step 4: Read the results

The window runs its checks automatically. Each line gets a ✅, ❌ or ℹ️:

| Check | What a ❌ means |
|---|---|
| App launched | (If you can see the window, this passed.) |
| Save a local file | The app can't save data on this machine. Unusual. |
| OS keychain | We can't store the GitHub token securely. There's a fallback. |
| GitHub API | GitHub is blocked by the company network/proxy. **Sync won't work as designed.** |
| Microsoft sign-in / Graph | Unlikely on a work laptop. Would block the To Do import. |

Click **Copy results** and paste them to Claude.

### Optional: test writing to GitHub

This checks that a real save to a repo gets through the company network.

1. On github.com, create a new **private** repo called `canvas-planner-data`. Tick "Add a README" so it isn't empty.
2. Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:
   - Expiration: 7 days (this is only a test)
   - Repository access: **Only select repositories** → `canvas-planner-data`
   - Permissions → Repository → **Contents: Read and write**
3. In the app, expand **"Optional: test writing to a GitHub repo"**. Enter `yourname/canvas-planner-data` and the token, then click **Write test file**.
4. A ✅ means a file appeared in the repo under `phase0/`. The app doesn't save the token anywhere.

## Step 5: Report back

Paste the copied results to Claude, plus anything you noted along the way:

- Was the download blocked?
- Which warning appeared, and did "Run anyway" / "Open Anyway" exist?
- Windows or Mac? Personal or managed?

From that we'll know whether to continue with the desktop app, or switch to Plan B (the same app served as a web page from GitHub Pages).
