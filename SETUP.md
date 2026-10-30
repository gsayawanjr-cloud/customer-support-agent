# Customer support demo: setup and test

## 1. Accounts (fill each value into `.env`)
1. **Trigger.dev project**: cloud.trigger.dev → New project ("customer-support"). Copy the ref (`proj_...`) into `trigger.config.ts`, and the Development secret key (`tr_dev_...`) into `TRIGGER_SECRET_KEY`.
2. **Anthropic key**: platform.claude.com → API keys → Create key → `ANTHROPIC_API_KEY`.
3. **Gmail app password**: signed in as the support Gmail, myaccount.google.com/apppasswords → create "customer-support" → `SUPPORT_GMAIL_APP_PASSWORD`. Put the Gmail address in `SUPPORT_GMAIL_USER`.
4. **Google service account**:
   1. console.cloud.google.com → create a project (e.g. "support-demo").
   2. APIs & Services → Library → **Google Sheets API** → Enable.
   3. IAM & Admin → Service accounts → Create (name "support-demo"); no roles needed.
   4. Open it → Keys → Add key → JSON. Paste the file's whole content on ONE line into `GOOGLE_SERVICE_ACCOUNT_JSON`, then delete the downloaded file.
      - **"Service account key creation is disabled"** (org policy `iam.disableServiceAccountKeyCreation`, on by default for new organizations): at the organization level grant yourself *Organization Policy Administrator*; then in this project, IAM & Admin → Organization Policies → "Disable service account key creation" (and the `managed.` one if listed) → Manage policy → Override parent's policy → Enforcement Off → Set policy; wait a few minutes, create the key, then set the policy back to *Inherit parent's policy* (existing keys keep working).
5. **Sheet**: create a blank Google Sheet, Share → paste the service account's `client_email` → Editor. Copy the ID from the URL into `SUPPORT_SHEET_ID`.
6. `ALERT_EMAIL_TO`: your own email for handoffs.

## 2. Test (in this order)
| Step | Task | Costs |
|---|---|---|
| Rules check | `support-self-test` | free |
| Create tabs + demo orders | `seed-store` | free |
| Send the 15 mock emails | `send-test-emails` | free |
| Preview without writing | `check-support-inbox` `{ "dryRun": true }` | Claude, ~$0.50–1 |
| Real run (drafts, sheet, alerts) | `check-support-inbox` | Claude, ~$0.50–1 |
| Compare with expected | `check-test-results` | free |
| Mark Reviewer Verdict, then numbers | `support-metrics` | free |

Start the dev server with `npm run dev`. Restart a test from zero with `seed-store` `{ "overwrite": true, "clearLog": true }` (also delete the test drafts in Gmail).
