# Plan for Improving the Overall Performance of the System

## Notes

- kill <process id>
- lsof -i :<port>
- `openssl rand -base64 32` or `node -e "console.log(require('crypto').randomUUID())"`
- 
-

-------------------------------------------------
## Task List

### Bugs

#### Priority Lv: P0
- [x] AI Lover and AI Reply both rules are active still no auto reply is coming. Debug, find RC and fix this issue

	These are the last few logs:

	```
	```

- [] Fix these git commit review findings:

	- [P1] Do not encrypt provider secrets with a public fallback key" body="If neither AUTOMATION_SECRET_KEY nor API_MASTER_KEY is set, provider API keys are encrypted with a hard-coded value. The generated/default config does not require either env var, so a production deployment can silently store recoverable provider keys. Prefer failing startup/provider creation when no real secret is configured, or generate and persist a local secret with clear rotation semantics." file="/Users/ani/Developer/ANI/ProjectsOrgs/1VibeCodeAI/Codex/OpenWA/src/modules/automation/automation-crypto.service.ts" start=9 priority=1}

	- [P2] Wrap rule save and child replacement in one transaction" body="The parent rule is saved before targets/triggers are replaced. If child persistence fails, for example two user inputs normalize to the same target and hit the unique constraint, the API returns an error but leaves a partially-created or partially-updated rule in the database. Save the rule and replaceChildren inside one transaction, or validate normalized duplicates before saving." file="/Users/ani/Developer/ANI/ProjectsOrgs/1VibeCodeAI/Codex/OpenWA/src/modules/automation/automation.service.ts" start=59 end=60 priority=2}

	- [P2] Deleting a provider leaves active AI rules broken" body="This nulls providerId on every referencing rule but leaves those AI automation rules active. The next matching message then fails with `AI provider not found` and records failed runs until someone manually edits or disables the rule. Either block deletion while rules reference the provider, or deactivate/mark affected AI rules and surface that state explicitly." file="/Users/ani/Developer/ANI/ProjectsOrgs/1VibeCodeAI/Codex/OpenWA/src/modules/automation/ai-provider.service.ts" start=106 priority=2}

- [] You are helping me refine an auto-reply bot’s behavior.

	Rewrite the bot logic and reply rules so the system behaves correctly under real-world delays, backlogs, and message bursts.

	Requirements:

	1. Startup and message scope
	- When the bot starts running, it must not re-process messages that were already answered or still left to be answered before startup.
	- It should process only:
	  - unanswered messages from before startup, and
	  - every new incoming message received after startup.
	- Never send duplicate replies to the same message.

	2. Queue and delivery behavior
	- If many new messages arrive quickly, place unanswered messages into a queue.
	- Process the queue one by one in a stable order.
	- Keep replying until the queue is empty, unless a timeout, retry limit, API limit, or safety limit is reached.
	- If a reply attempt fails temporarily, retry in a controlled way without duplicating replies.
	- The bot should be designed to answer every message it reasonably can.

	3. Reply style
	- Replies must sound natural, warm, and human.
	- Do not mention that you are a bot, assistant, AI, automation, or system in any reply.
	- Avoid self-references about being software.
	- Use double quotes for replies unless another format is strictly necessary.
	- Keep replies concise, friendly, and context-aware.

	4. Output quality
	- Fix ambiguous wording.
	- Improve the logic so it is clear, robust, and production-friendly.
	- Preserve the original intent, but rewrite it in a cleaner and more reliable way.

	Now produce:
	- the improved prompt,
	- the corrected behavior rules,
	- and a polished example reply style guide.

- [] Avoid auto replying to business accounts.

- []
- []
- []
- []

#### Priority Lv: P1
- []
- []
- []

### New features

#### Priority Lv: P0
- []
- []
- []

#### Priority Lv: P1
- []
- []
- []

-------------------------------------------------


