# GitHub Project Ops

Use these snippets when running the delivery-board workflow.

## Inspect project state

```bash
gh api graphql -f query='
query {
  organization(login:"unbrowse-ai") {
    projectV2(number: 2) {
      id
      title
      url
      public
      views(first:20) { nodes { id name number layout } }
      fields(first:30) {
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
      items(first:20) {
        totalCount
        nodes {
          id
          content { ... on Issue { number title } }
          fieldValues(first:20) {
            nodes {
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}'
```

## Fetch contributor velocity

```bash
gh api graphql -f query='
query {
  user(login:"justrach") {
    contributionsCollection(
      from:"2026-01-01T00:00:00Z",
      to:"2026-03-23T23:59:59Z"
    ) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      contributionCalendar { totalContributions }
    }
  }
}'
```

Repo-level pace:

```bash
gh api graphql -f query='
query {
  r1: repository(owner:"justrach", name:"unbrowse34") {
    defaultBranchRef {
      target {
        ... on Commit {
          history(since:"2026-01-01T00:00:00Z") { totalCount }
          m1: history(since:"2026-03-01T00:00:00Z") { totalCount }
        }
      }
    }
  }
}'
```

## List project item ids

```bash
gh api graphql -f query='
query {
  organization(login:"unbrowse-ai") {
    projectV2(number: 2) {
      items(first:100) {
        nodes {
          id
          content { ... on Issue { number title } }
        }
      }
    }
  }
}' | jq -r '.data.organization.projectV2.items.nodes[]
| select(.content.number != null)
| [.content.number, .id, .content.title]
| @tsv'
```

## Create date fields

```bash
gh api graphql -f query='
mutation($project:ID!,$name:String!){
  createProjectV2Field(input:{
    projectId:$project,
    dataType:DATE,
    name:$name
  }) {
    projectV2Field { ... on ProjectV2Field { id name dataType } }
  }
}' -F project='PVT_...' -F name='Start Date'
```

Repeat for `Target Date`.

## Stamp one date

```bash
gh api graphql \
  -f query='mutation($project:ID!,$item:ID!,$field:ID!,$date:Date!){
    updateProjectV2ItemFieldValue(input:{
      projectId:$project,
      itemId:$item,
      fieldId:$field,
      value:{date:$date}
    }) {
      projectV2Item { id }
    }
  }' \
  -F project='PVT_...' \
  -F item='PVTI_...' \
  -F field='PVTF_...' \
  -F date='2026-04-17'
```

## Bulk date stamp pattern

Use `zsh`, not macOS system `bash`, if you want associative arrays.

```bash
zsh <<'EOF'
set -euo pipefail
project_id='PVT_...'
start_field='PVTF_START...'
target_field='PVTF_TARGET...'

typeset -A item_ids starts targets
item_ids=(43 PVTI_foo 46 PVTI_bar)
starts=(43 2026-03-23 46 2026-03-30)
targets=(43 2026-04-17 46 2026-04-30)

set_date() {
  local item_id="$1" field_id="$2" date="$3"
  gh api graphql \
    -f query='mutation($project:ID!,$item:ID!,$field:ID!,$date:Date!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project,
        itemId:$item,
        fieldId:$field,
        value:{date:$date}
      }) {
        projectV2Item { id }
      }
    }' \
    -F project="$project_id" -F item="$item_id" -F field="$field_id" -F date="$date" >/dev/null
}

for num item_id in ${(kv)item_ids}; do
  [[ -n ${starts[$num]-} ]] && set_date "$item_id" "$start_field" "$starts[$num]"
  [[ -n ${targets[$num]-} ]] && set_date "$item_id" "$target_field" "$targets[$num]"
done
EOF
```

## Verify sample items after mutation

```bash
gh api graphql -f query='
query {
  organization(login:"unbrowse-ai") {
    projectV2(number: 2) {
      items(first:100) {
        nodes {
          content { ... on Issue { number title } }
          fieldValues(first:20) {
            nodes {
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}' | jq '.data.organization.projectV2.items.nodes[]
| select(.content.number==43 or .content.number==46)'
```

## Typical board defaults

- visibility: private
- views: default table, one kanban, one roadmap
- custom fields: `Track`, `Paper`, `Sprint`, `Start Date`, `Target Date`
- verify blockers in issues, not only labels
