# Importing tasks

Click **Import** in the toolbar. There are three ways to bring tasks in:

| Tab | Best for | Needs internet? |
|---|---|---|
| **Paste a list** | Any list you can copy: notes, emails, Word, OneNote, To Do | No |
| **CSV file** | Spreadsheets and exports from other apps (Excel, Outlook, Planner…) | No |
| **Microsoft To Do** | Pulling your To Do lists straight in | Yes, plus a one-time setup |

New tasks appear in a tidy grid in the middle of your view, and the canvas zooms to show everything.

---

## Paste a list

1. Copy your list from anywhere and paste it into the box, one task per line.
2. The count under the box shows how many tasks will be added.
3. Click **Import** (or press Ctrl+Enter / Cmd+Enter).

What it understands:

- **Bullets and numbers are removed**: `-`, `*`, `•`, `1.`, `1)` and checkboxes `[ ]`.
- **Ticked items** (`[x]`) are skipped. Tick **"Also import ticked items as completed"** if you want them on the canvas as done.
- **Blank lines** are ignored.
- **Due dates:** put a date like `2026-12-03` anywhere on the line, or write `due: 3/12`. The short form is **day/month** (3/12 means 3 December). Without a year, it means the next 3 December (unless that was only a few weeks ago).

Example:

```
- Book dentist appointment
- Send quarterly report due: 3/12
1. Renew passport 2027-02-01
[x] Already done (skipped)
```

Pasted tasks don't get a source badge.

## CSV file

1. Click **Choose file** and pick a `.csv` file. Its first row must be the column names.
2. The app guesses which column is which (Title/Subject/Task/Name, Notes/Body/Description, Due Date, Status/Completed). Use the drop-downs to fix any wrong guesses.
3. **Date format:** leave it on *Automatic* unless the preview shows wrong dates. Automatic looks at every date in the column and picks the format that fits all of them. If it can't tell (e.g. every date is like 03/04/2026), it assumes **day/month/year**.
4. **Skip completed tasks** is on by default. Turn it off to bring finished tasks in as done.
5. Check the preview (first 5 tasks) and click **Import**.

Files from Excel in European languages that use `;` instead of `,` work too. Imported tasks get a small **CSV** badge.

## Microsoft To Do

This reads your To Do lists using Microsoft's official API (Microsoft Graph). It is **read-only** and **one-way**: tasks are copied from To Do onto your canvas. Completing or editing a task on the canvas does **not** change it in To Do, and vice versa.

Using it:

1. Do the one-time setup below, and paste your **Application (client) ID** into the Setup section of the tab.
2. Click **Sign in with Microsoft**. A short code appears.
3. Click **Copy code & open sign-in page**. Your browser opens a Microsoft page: paste the code, sign in, and accept the permission prompt ("Read your tasks").
4. Come back to Canvas Planner. It notices you've signed in after a few seconds.
5. Tick the lists you want, choose whether to **include completed** tasks (off by default), and click **Import**.

Each imported task gets a **To Do** badge. If you import again later, tasks already on your canvas are skipped (you'll see "N already on your canvas"), so it's safe to re-import to pick up new tasks. If you delete an imported card and import again, it comes back.

You stay signed in: the app keeps a sign-in token in your computer's secure keychain (never in a plain file). Click **Sign out** to remove it.

### Setting up Microsoft To Do import (one time, about 5 minutes)

Canvas Planner doesn't come with its own Microsoft "app ID", so you register a free one yourself. You don't need to pay for anything.

1. Go to **https://portal.azure.com** and sign in.
   - With a **work account**, use your work sign-in.
   - With only a **personal account** (outlook.com, hotmail.com, live.com), the portal may first ask you to set up a free Azure account or directory before it lets you register apps.
2. In the search bar at the top, type **App registrations** and open it. Click **+ New registration**.
3. **Name:** anything, e.g. `Canvas Planner`.
4. **Supported account types:** this decides who can sign in.
   - Your To Do is on a **personal** Microsoft account → choose **"Personal Microsoft accounts only"** (then set Tenant to **consumers** in the app), or the option that includes **"personal Microsoft accounts"** (Tenant **common**).
   - Your To Do is on a **work or school** account → choose **"Accounts in this organizational directory only"** (then set Tenant to your organisation's domain or tenant ID, shown on the app's Overview page as *Directory (tenant) ID*), or **"Accounts in any organizational directory"** (Tenant **organizations**).
   - Not sure? Choose the option that includes **both** organisational and personal accounts and use Tenant **common**.
5. **Redirect URI:** leave it empty. It isn't needed. Click **Register**.
6. In the left menu, open **Authentication**. Find **"Allow public client flows"** (on newer layouts it's on the *Settings* tab) and set it to **Yes**. Click **Save**.
7. In the left menu, open **API permissions** → **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**. Search for **Tasks.Read**, tick it, and click **Add permissions**. (The "stay signed in" permission, `offline_access`, is requested automatically; you don't need to add it.)
8. Open **Overview** and copy the **Application (client) ID** (it looks like `1a2b3c4d-1234-5678-9abc-1234567890ab`).
9. In Canvas Planner: **Import → Microsoft To Do → Setup**. Paste the ID, choose the Tenant that matches step 4, and click **Save**.

**About work accounts:** many companies don't let staff approve new apps themselves. If so, after signing in you'll see a message that your organisation's IT must approve the app ("admin consent"). Whether this happens depends entirely on your company's policy. You can ask IT to grant consent for your app registration, or simply use the **Paste** tab instead.

### Getting tasks out of To Do without the Microsoft sign-in

Microsoft To Do has **no "export to CSV" button**. Options that don't need the setup above:

- **Copy and paste:** open a list in To Do, copy the task titles (one by one, or by selecting them if your version lets you), and paste them into the **Paste a list** tab. Due dates won't come across this way, but you can add `due: 3/12` to a line yourself.
- **Classic Outlook for Windows:** if your To Do tasks are on a work/Exchange account, they also appear in Outlook's **Tasks** folder. In *classic* Outlook (not the "new Outlook"), use **File → Open & Export → Import/Export → Export to a file → Comma Separated Values**, pick the **Tasks** folder, and save the file. Then import it in the **CSV file** tab. (Your company may have disabled exporting.)

### Troubleshooting

| Message | What to do |
|---|---|
| "Couldn't reach Microsoft…" | Your network or company proxy is blocking Microsoft's sign-in or Graph servers. Use Paste or CSV. |
| "Your organisation's IT needs to approve this app…" | Admin consent is required (see above). Ask IT, or use Paste. |
| "Microsoft doesn't recognise that Application (client) ID" | Re-copy the ID from the app's Overview page, and check the Tenant setting matches step 4. |
| "…doesn't allow this kind of sign-in" | Step 6 was missed: set **Allow public client flows** to **Yes** and save. |
| "…personal Microsoft accounts only" / "…one organisation only" | Change the Tenant setting as the message says. |
| "…sent a browser Origin header" | This needs a small fix inside the app (it's a known issue with the HTTP component the app uses). Tell whoever builds your copy of Canvas Planner. Meanwhile use Paste or CSV. |
| The sign-in code expired | Codes last about 15 minutes. Click **Sign in** again for a new one. |
