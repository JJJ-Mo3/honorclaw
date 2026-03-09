# Creating Custom Skills

Skills are reusable agent configuration bundles — a system prompt plus a capability manifest packaged together. Install a skill onto any agent to give it a pre-configured persona with the right tools, egress rules, and guardrails.

## What's in a Skill?

A skill is a directory with two files:

```
my-skill/
  skill.yaml          # Tools, egress, session limits, guardrails
  system-prompt.md     # Behavioral instructions for the agent
```

That's it. Skills are YAML configurations, not executables.

## Step 1: Scaffold a New Skill

```bash
honorclaw skills init my-skill
```

This creates:

```
my-skill/
  skill.yaml          # Template manifest
  system-prompt.md     # Template prompt
```

## Step 2: Define the Manifest

Edit `skill.yaml` to define what the skill can do:

```yaml
name: my-skill
version: "1.0.0"
description: "Short description of what this skill does"

# Tools this skill needs
tools:
  - name: web_search
  - name: jira_search_issues
  - name: jira_read_issue
  - name: jira_create_issue
    requires_approval: true    # Human must approve ticket creation
  - name: slack_post_message
    requires_approval: true    # Human must approve Slack messages

# External domains the tools can reach
egress:
  allowed_domains:
    - "*.atlassian.net"
    - slack.com
    - api.slack.com

# Session configuration
session:
  max_turns: 20               # Max conversation turns

# Trust level: standard, elevated, or restricted
trust_level: standard

# Input protection
input_guardrails:
  injection_detection: true
  max_message_length: 4000
```

### Available Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier (lowercase, hyphens) |
| `version` | Yes | Semantic version string |
| `description` | Yes | Human-readable description |
| `tools` | Yes | List of tool configurations |
| `tools[].name` | Yes | Tool name (must match a registered tool) |
| `tools[].requires_approval` | No | Require human approval (default: false) |
| `egress.allowed_domains` | No | Domains tools can reach |
| `session.max_turns` | No | Max conversation turns |
| `trust_level` | No | `standard` (default), `elevated`, or `restricted` |
| `input_guardrails.injection_detection` | No | Enable injection detection (default: true) |
| `input_guardrails.max_message_length` | No | Max input length (default: 4000) |

## Step 3: Write the System Prompt

Edit `system-prompt.md` to define the agent's persona and behavior:

```markdown
You are a [role]. Your job is to [primary responsibility].

## Core Responsibilities

1. **[Responsibility]**: [Description of what to do and how]

2. **[Responsibility]**: [Description]

3. **[Responsibility]**: [Description]

## Safety Rules

- Never [prohibited action]
- Always [required action]
- If [condition], then [escalation action]
```

### System Prompt Best Practices

1. **Be specific**: "You are a Jira project manager" is better than "You are helpful"
2. **Define the workflow**: Step-by-step instructions for common tasks
3. **Set boundaries**: What the agent should never do
4. **Include output formats**: Show the agent how to structure its responses
5. **Add escalation rules**: When to hand off to a human
6. **Keep it under 2000 words**: Shorter prompts are more reliably followed

## Step 4: Install and Test

### Install from local directory

```bash
honorclaw skills install my-skill
```

### Apply to an agent

```bash
# Via API
curl -X POST http://localhost:3000/api/skills/agents/<agent-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"skillName": "my-skill"}'
```

### Test the agent

```bash
honorclaw chat <agent-name>
```

## Complete Example: DevOps Triage Skill

### `devops-triage/skill.yaml`

```yaml
name: devops-triage
version: "1.0.0"
description: "DevOps triage assistant — monitors alerts, checks infrastructure status, and coordinates response"

tools:
  - name: pagerduty_list_incidents
  - name: pagerduty_read_incident
  - name: pagerduty_acknowledge_incident
    requires_approval: true
  - name: pagerduty_add_note
  - name: slack_post_message
    requires_approval: true
  - name: slack_read_channel_history
  - name: web_search
  - name: memory_search

egress:
  allowed_domains:
    - api.pagerduty.com
    - slack.com
    - api.slack.com

session:
  max_turns: 25

trust_level: standard

input_guardrails:
  injection_detection: true
  max_message_length: 4000
```

### `devops-triage/system-prompt.md`

```markdown
You are a DevOps triage assistant. Your job is to help on-call engineers
quickly assess and respond to infrastructure alerts.

## Core Responsibilities

1. **Alert assessment**: When an alert comes in, gather context:
   - Check PagerDuty for the full incident details
   - Look for related incidents in the last 24 hours
   - Search memory for similar past incidents and their resolutions

2. **Status summary**: Produce a structured summary:
   - What is happening (symptoms)
   - What is affected (services, users)
   - Current severity and who is on-call
   - Similar past incidents and how they were resolved

3. **Response coordination**: Post updates to the #incidents Slack channel:
   - Initial alert summary
   - Status changes
   - Resolution confirmation

## Output Format

### Alert Summary
```
Incident: [PD incident ID]
Severity: [P1/P2/P3/P4]
Service: [affected service]
Started: [timestamp]
Status: [triggered/acknowledged/resolved]
On-Call: [engineer name]
Summary: [1-2 sentences]
Similar Past Incidents: [list or "none found"]
Suggested Action: [recommendation]
```

## Safety Rules

- Never restart services, deploy code, or modify infrastructure
- Never share infrastructure credentials or internal IPs
- Recommend actions for human execution
- If unsure about severity, default to higher severity
```

## Available Built-in Tools

These tools can be referenced in your skill's `tools` list:

| Category | Tools |
|----------|-------|
| **Productivity** | `gsuite_gmail_read`, `gsuite_gmail_send`, `gsuite_calendar_list`, `gsuite_calendar_create`, `gsuite_drive_read`, `gsuite_drive_write`, `gsuite_sheets_read`, `gsuite_sheets_write`, `gsuite_contacts_read`, `gsuite_contacts_search` |
| **Microsoft 365** | `m365_outlook_read`, `m365_outlook_send`, `m365_calendar_list`, `m365_calendar_create`, `m365_onedrive_read`, `m365_onedrive_write`, `m365_excel_read`, `m365_excel_write`, `m365_contacts_read`, `m365_contacts_search` |
| **Developer** | `github_list_prs`, `github_read_pr`, `github_read_issue`, `github_get_file`, `github_list_repos`, `github_search_code`, `github_list_actions`, `github_trigger_workflow`, `github_comment_on_issue` |
| **Jira** | `jira_search_issues`, `jira_read_issue`, `jira_create_issue`, `jira_add_comment`, `jira_list_sprints`, `jira_list_projects` |
| **Confluence** | `confluence_read_page`, `confluence_create_page`, `confluence_search`, `confluence_list_spaces` |
| **Notion** | `notion_read_page`, `notion_create_page`, `notion_query_database`, `notion_append_to_page`, `notion_search` |
| **Slack** | `slack_post_message`, `slack_read_channel_history`, `slack_search`, `slack_lookup_user`, `slack_list_channels` |
| **PagerDuty** | `pagerduty_list_incidents`, `pagerduty_read_incident`, `pagerduty_acknowledge_incident`, `pagerduty_add_note`, `pagerduty_list_schedules`, `pagerduty_list_services`, `pagerduty_create_incident` |
| **Salesforce** | `salesforce_query`, `salesforce_read_record`, `salesforce_create_record`, `salesforce_update_record`, `salesforce_list_cases`, `salesforce_search` |
| **Data** | `snowflake_query`, `snowflake_describe_table`, `snowflake_list_tables`, `bigquery_query`, `bigquery_describe_table`, `bigquery_list_tables`, `bigquery_list_datasets` |
| **Core** | `web_search`, `http_request`, `file_ops`, `database_query`, `code_execution`, `memory_search`, `email_send` |
| **AI** | `claude_code_run`, `claude_code_review`, `claude_code_test`, `claude_code_refactor` |

## Managing Skills

```bash
# List installed skills
honorclaw skills list

# Browse available (bundled) skills
honorclaw skills available

# Search skills
honorclaw skills search "jira"

# View skill details
honorclaw skills inspect customer-support

# Remove a skill
honorclaw skills remove my-skill
```

## Next Steps

- [Creating Custom Agents](creating-agents.md) — Deploy agents with your skills
- [Creating Custom Tools](creating-tools.md) — Build new tools for your skills
- [Manifest Reference](manifest-reference.md) — Complete field reference
